// Errors raised by the relayer and its sponsorship policy, mapped to HTTP responses by the
// relay routes. Kept in its own module so relayer.js and sponsorship.js can share it.
class RelayerError extends Error {
    constructor(code, status, message, { retryAfter } = {}) {
        super(message);
        this.name = 'RelayerError';
        this.code = code;
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

// Checked by name rather than instanceof, which fails if the module is loaded twice
const isRelayerError = (err) => err?.name === 'RelayerError' && Number.isInteger(err.status);

module.exports = { RelayerError, isRelayerError };
