import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import app from '../index.js';
import {
    checkReplicationLag,
    checkConnectionPool,
    verifyDailySnapshot,
    getStorageHealthReport,
} from '../storage-health.js';

describe('Storage Health, Replication Monitor & Snapshot Verification', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-storage-test-'));
        delete app.locals.mockReplicationLagQuery;
        delete app.locals.snapshotVerificationOptions;
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('Replication Monitor (checkReplicationLag)', () => {
        it('reports healthy when WAL replication lag is within 60 seconds', async () => {
            const result = await checkReplicationLag({
                queryFn: async () => 14.5, // 14.5s lag
            });

            expect(result.status).toBe('healthy');
            expect(result.lag_seconds).toBe(14.5);
            expect(result.critical).toBe(false);
            expect(result.error).toBeNull();
        });

        it('reports critical error when WAL replication lag exceeds 60 seconds', async () => {
            const result = await checkReplicationLag({
                queryFn: async () => 72.3, // 72.3s lag > 60s
            });

            expect(result.status).toBe('critical');
            expect(result.lag_seconds).toBe(72.3);
            expect(result.critical).toBe(true);
            expect(result.error).toMatch(/exceeds 60s threshold/i);
        });
    });

    describe('Snapshot Verification (verifyDailySnapshot)', () => {
        it('verifies valid non-empty daily snapshot', () => {
            const snapshotFile = path.join(tempDir, 'orbit_backup_daily.sql');
            fs.writeFileSync(snapshotFile, '-- Orbit DB Dump\nCREATE TABLE test();\n');

            const result = verifyDailySnapshot({
                snapshotPath: snapshotFile,
            });

            expect(result.status).toBe('healthy');
            expect(result.exists).toBe(true);
            expect(result.size_bytes).toBeGreaterThan(0);
            expect(result.last_snapshot).toBeDefined();
        });

        it('reports missing when snapshot file does not exist', () => {
            const missingFile = path.join(tempDir, 'nonexistent_backup.sql');
            const result = verifyDailySnapshot({
                snapshotPath: missingFile,
            });

            expect(result.status).toBe('missing');
            expect(result.exists).toBe(false);
            expect(result.error).toMatch(/does not exist/i);
        });

        it('reports error when snapshot file is empty (0 bytes)', () => {
            const emptyFile = path.join(tempDir, 'empty_backup.sql');
            fs.writeFileSync(emptyFile, '');

            const result = verifyDailySnapshot({
                snapshotPath: emptyFile,
            });

            expect(result.status).toBe('empty');
            expect(result.exists).toBe(true);
            expect(result.size_bytes).toBe(0);
            expect(result.error).toMatch(/empty/i);
        });

        it('reports stale when snapshot file is older than 24 hours', () => {
            const staleFile = path.join(tempDir, 'stale_backup.sql');
            fs.writeFileSync(staleFile, 'Valid backup content');
            const thirtyHoursAgo = new Date(Date.now() - 30 * 3600 * 1000);
            fs.utimesSync(staleFile, thirtyHoursAgo, thirtyHoursAgo);

            const result = verifyDailySnapshot({
                snapshotPath: staleFile,
            });

            expect(result.status).toBe('stale');
            expect(result.exists).toBe(true);
            expect(result.age_hours).toBeGreaterThanOrEqual(29);
            expect(result.error).toMatch(/stale/i);
        });
    });

    describe('Connection Pool Monitor (checkConnectionPool)', () => {
        it('detects healthy pool within capacity', () => {
            const pool = {
                totalCount: 5,
                idleCount: 3,
                waitingCount: 0,
                options: { max: 20 },
            };
            const result = checkConnectionPool(pool);
            expect(result.connection_count).toBe(5);
            expect(result.idle_connections).toBe(3);
            expect(result.waiting_connections).toBe(0);
            expect(result.exhausted).toBe(false);
        });

        it('detects exhausted pool when clients are waiting with zero idle connections at max capacity', () => {
            const pool = {
                totalCount: 20,
                idleCount: 0,
                waitingCount: 7,
                options: { max: 20 },
            };
            const result = checkConnectionPool(pool);
            expect(result.exhausted).toBe(true);
        });
    });

    describe('Health Check Endpoint (GET /api/health/storage)', () => {
        it('returns status 200 with JSON metrics when storage is healthy', async () => {
            const snapshotFile = path.join(tempDir, 'healthy_backup.sql');
            fs.writeFileSync(snapshotFile, 'DUMP');

            app.locals.mockReplicationLagQuery = async () => 2.4;
            app.locals.snapshotVerificationOptions = { snapshotPath: snapshotFile };

            const response = await request(app).get('/api/health/storage');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('healthy');
            expect(response.body.database).toBeDefined();
            expect(response.body.database.exhausted).toBe(false);
            expect(response.body.replication).toBeDefined();
            expect(response.body.replication.lag_seconds).toBe(2.4);
            expect(response.body.replication.critical).toBe(false);
            expect(response.body.backup).toBeDefined();
            expect(response.body.backup.exists).toBe(true);
        });

        it('returns HTTP 503 if replication lag is critical (> 60 seconds)', async () => {
            app.locals.mockReplicationLagQuery = async () => 85.0; // 85s lag

            const response = await request(app).get('/api/health/storage');

            expect(response.status).toBe(503);
            expect(response.body.status).toBe('critical');
            expect(response.body.replication.critical).toBe(true);
            expect(response.body.replication.lag_seconds).toBe(85.0);
            expect(response.body.replication.error).toMatch(/exceeds 60s threshold/i);
        });

        it('returns HTTP 503 if database connection pool is exhausted', async () => {
            const originalPool = app.locals.reportPool;
            app.locals.reportPool = {
                totalCount: 10,
                idleCount: 0,
                waitingCount: 5,
                options: { max: 10 },
                isExhausted: true,
            };

            try {
                const response = await request(app).get('/api/health/storage');
                expect(response.status).toBe(503);
                expect(response.body.database.exhausted).toBe(true);
            } finally {
                app.locals.reportPool = originalPool;
            }
        });
    });
});
