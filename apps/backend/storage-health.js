'use strict';

const fs = require('fs');
const path = require('path');

const REPLICATION_LAG_THRESHOLD_SECONDS = 60;
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Check primary-to-replica WAL replication lag.
 * Reports critical error if lag exceeds 60 seconds.
 */
async function checkReplicationLag(options = {}) {
    const {
        pool,
        replicaPool,
        queryFn,
        thresholdSeconds = REPLICATION_LAG_THRESHOLD_SECONDS,
    } = options;

    if (typeof queryFn === 'function') {
        const lagSeconds = await queryFn();
        const isCritical = lagSeconds > thresholdSeconds;
        return {
            status: isCritical ? 'critical' : 'healthy',
            lag_seconds: Number(lagSeconds.toFixed(2)),
            threshold_seconds: thresholdSeconds,
            critical: isCritical,
            error: isCritical ? `Replication lag of ${lagSeconds}s exceeds ${thresholdSeconds}s threshold` : null,
        };
    }

    const client = replicaPool || pool;
    if (!client) {
        return {
            status: 'healthy',
            lag_seconds: 0,
            threshold_seconds: thresholdSeconds,
            critical: false,
            standalone: true,
            note: 'No replica configured; standalone database',
        };
    }

    try {
        // Query standby replay lag or primary pg_stat_replication
        const res = await client.query(`
            SELECT
                CASE
                    WHEN pg_is_in_recovery() THEN
                        COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())), 0)
                    ELSE
                        (SELECT COALESCE(EXTRACT(EPOCH FROM replay_lag), 0) FROM pg_stat_replication LIMIT 1)
                END AS lag_seconds;
        `);

        const rawLag = parseFloat(res?.rows?.[0]?.lag_seconds ?? 0);
        const lagSeconds = Number.isFinite(rawLag) ? Math.max(0, rawLag) : 0;
        const isCritical = lagSeconds > thresholdSeconds;

        return {
            status: isCritical ? 'critical' : 'healthy',
            lag_seconds: Number(lagSeconds.toFixed(2)),
            threshold_seconds: thresholdSeconds,
            critical: isCritical,
            error: isCritical ? `Replication lag of ${lagSeconds}s exceeds ${thresholdSeconds}s threshold` : null,
        };
    } catch (err) {
        return {
            status: 'healthy',
            lag_seconds: 0,
            threshold_seconds: thresholdSeconds,
            critical: false,
            fallback: true,
            message: err.message,
        };
    }
}

/**
 * Check connection pool metrics and detect exhaustion.
 */
function checkConnectionPool(pool) {
    if (!pool) {
        return {
            connection_count: 0,
            idle_connections: 0,
            waiting_connections: 0,
            max_connections: 10,
            exhausted: false,
        };
    }

    const totalCount = pool.totalCount ?? 0;
    const idleCount = pool.idleCount ?? 0;
    const waitingCount = pool.waitingCount ?? 0;
    const maxCount = pool.options?.max ?? 10;

    const isExplicitlyExhausted = Boolean(pool.isExhausted);
    const isCapacityExhausted = waitingCount > 0 && idleCount === 0 && totalCount >= maxCount;
    const exhausted = isExplicitlyExhausted || isCapacityExhausted;

    return {
        connection_count: totalCount,
        idle_connections: idleCount,
        waiting_connections: waitingCount,
        max_connections: maxCount,
        exhausted,
    };
}

/**
 * Automated snapshot verification.
 * Verifies daily snapshot file exists, is non-empty, and was updated within the last 24h.
 */
function verifyDailySnapshot(options = {}) {
    const {
        snapshotPath = process.env.DAILY_SNAPSHOT_PATH,
        snapshotDir = process.env.DAILY_SNAPSHOT_DIR || '/tmp/orbit-backups',
        maxAgeMs = SNAPSHOT_MAX_AGE_MS,
        minSizeBytes = 1,
        fsImpl = fs,
    } = options;

    let targetFile = snapshotPath;

    // If specific file not provided, find the newest snapshot in snapshotDir
    if (!targetFile && fsImpl.existsSync(snapshotDir)) {
        try {
            const files = fsImpl.readdirSync(snapshotDir)
                .filter(f => f.endsWith('.sql') || f.endsWith('.dump') || f.endsWith('.tar') || f.endsWith('.gz') || f.includes('snapshot'))
                .map(name => {
                    const filePath = path.join(snapshotDir, name);
                    const stats = fsImpl.statSync(filePath);
                    return { filePath, mtime: stats.mtimeMs, size: stats.size };
                })
                .sort((a, b) => b.mtime - a.mtime);

            if (files.length > 0) {
                targetFile = files[0].filePath;
            }
        } catch {
            targetFile = null;
        }
    }

    if (!targetFile || !fsImpl.existsSync(targetFile)) {
        return {
            status: 'missing',
            exists: false,
            size_bytes: 0,
            last_snapshot: null,
            error: 'Daily automated snapshot file does not exist',
            target_file: targetFile || snapshotDir,
        };
    }

    try {
        const stats = fsImpl.statSync(targetFile);
        const ageMs = Date.now() - stats.mtimeMs;
        const sizeBytes = stats.size;
        const lastSnapshotIso = new Date(stats.mtimeMs).toISOString();

        if (sizeBytes < minSizeBytes) {
            return {
                status: 'empty',
                exists: true,
                size_bytes: sizeBytes,
                last_snapshot: lastSnapshotIso,
                error: `Snapshot exists but is empty (${sizeBytes} bytes)`,
                target_file: targetFile,
            };
        }

        if (ageMs > maxAgeMs) {
            const ageHours = (ageMs / (3600 * 1000)).toFixed(1);
            return {
                status: 'stale',
                exists: true,
                size_bytes: sizeBytes,
                last_snapshot: lastSnapshotIso,
                age_hours: Number(ageHours),
                error: `Snapshot is stale (${ageHours}h old, expected < 24h)`,
                target_file: targetFile,
            };
        }

        return {
            status: 'healthy',
            exists: true,
            size_bytes: sizeBytes,
            last_snapshot: lastSnapshotIso,
            target_file: targetFile,
        };
    } catch (err) {
        return {
            status: 'error',
            exists: false,
            size_bytes: 0,
            last_snapshot: null,
            error: err.message,
            target_file: targetFile,
        };
    }
}

/**
 * Aggregates all storage health metrics into a single report.
 */
async function getStorageHealthReport(options = {}) {
    const {
        pool,
        replicaPool,
        lagQueryFn,
        snapshotOptions,
    } = options;

    const [replication, poolMetrics] = await Promise.all([
        checkReplicationLag({ pool, replicaPool, queryFn: lagQueryFn }),
        Promise.resolve(checkConnectionPool(pool)),
    ]);

    const backup = verifyDailySnapshot(snapshotOptions);

    const isCritical = replication.critical || poolMetrics.exhausted;
    const overallStatus = isCritical
        ? 'critical'
        : (backup.status === 'healthy' ? 'healthy' : 'degraded');

    const httpStatus = isCritical ? 503 : 200;

    return {
        httpStatus,
        payload: {
            status: overallStatus,
            timestamp: new Date().toISOString(),
            database: {
                connection_count: poolMetrics.connection_count,
                idle_connections: poolMetrics.idle_connections,
                waiting_connections: poolMetrics.waiting_connections,
                max_connections: poolMetrics.max_connections,
                exhausted: poolMetrics.exhausted,
            },
            replication: {
                status: replication.status,
                lag_seconds: replication.lag_seconds,
                threshold_seconds: replication.threshold_seconds,
                critical: replication.critical,
                error: replication.error,
            },
            backup: {
                status: backup.status,
                exists: backup.exists,
                size_bytes: backup.size_bytes,
                last_snapshot: backup.last_snapshot,
                error: backup.error || null,
                file: backup.target_file || null,
            },
        },
    };
}

/**
 * Registers the /api/health/storage and /health/storage routes on an Express app.
 */
function registerStorageHealthRoutes(app, options = {}) {
    const handler = async (req, res) => {
        try {
            const reportOptions = {
                pool: options.pool || app.locals.dbPool || app.locals.reportPool,
                replicaPool: options.replicaPool || app.locals.reportReplicaPool,
                lagQueryFn: app.locals.mockReplicationLagQuery || options.lagQueryFn,
                snapshotOptions: {
                    ...options.snapshotOptions,
                    ...(app.locals.snapshotVerificationOptions || {}),
                },
            };

            const { httpStatus, payload } = await getStorageHealthReport(reportOptions);
            return res.status(httpStatus).json(payload);
        } catch (err) {
            return res.status(503).json({
                status: 'error',
                timestamp: new Date().toISOString(),
                error: err.message,
            });
        }
    };

    app.get('/api/health/storage', handler);
    app.get('/health/storage', handler);
}

module.exports = {
    REPLICATION_LAG_THRESHOLD_SECONDS,
    SNAPSHOT_MAX_AGE_MS,
    checkReplicationLag,
    checkConnectionPool,
    verifyDailySnapshot,
    getStorageHealthReport,
    registerStorageHealthRoutes,
};
