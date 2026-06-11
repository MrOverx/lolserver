const test = require('node:test');
const assert = require('node:assert/strict');
const { sendError } = require('../utils/responseHandler');

test('sendError includes a message field for clients', () => {
  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return payload;
    },
  };

  sendError(response, 401, 'Invalid email or password', 'INVALID_CREDENTIALS');

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.success, false);
  assert.equal(response.body.message, 'Invalid email or password');
  assert.equal(response.body.error, 'Invalid email or password');
  assert.equal(response.body.code, 'INVALID_CREDENTIALS');
});
