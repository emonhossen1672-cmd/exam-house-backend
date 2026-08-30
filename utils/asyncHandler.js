// utils/asyncHandler.js
//
// Express 4 does NOT automatically catch errors thrown/rejected inside an
// async route handler — an unhandled rejection there just leaves the request
// hanging (or, depending on process-level handlers, can crash the server).
//
// Wrap every async route handler with this:
//   router.get('/', asyncHandler(async (req, res) => { ... }));
// Any thrown error / rejected promise is forwarded to next(err), which hits
// the global error-handling middleware in server.js.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
