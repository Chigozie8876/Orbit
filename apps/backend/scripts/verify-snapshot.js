#!/usr/bin/env node
'use strict';

const { verifyDailySnapshot } = require('../storage-health');

function main() {
    console.log('[Storage Health] Running automated database snapshot verification...');
    const result = verifyDailySnapshot();

    console.log(`Snapshot Path:    ${result.target_file || 'N/A'}`);
    console.log(`Exists:           ${result.exists}`);
    console.log(`Size (bytes):     ${result.size_bytes}`);
    console.log(`Last Snapshot:    ${result.last_snapshot || 'Never'}`);
    console.log(`Status:           ${result.status.toUpperCase()}`);

    if (result.status === 'healthy') {
        console.log('[Storage Health] SUCCESS: Daily snapshot verified and non-empty.');
        process.exit(0);
    } else {
        console.error(`[Storage Health] FAILURE: Snapshot check failed - ${result.error}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { main };
