import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeClientSecret } from "../build/auth/types.js";

test("sanitizeClientSecret: bare value passes through unchanged", () => {
  assert.equal(sanitizeClientSecret("test-secret-value"), "test-secret-value");
});

test("sanitizeClientSecret: trims surrounding whitespace", () => {
  assert.equal(sanitizeClientSecret("  test-secret-value  "), "test-secret-value");
});

test("sanitizeClientSecret: strips CR and LF", () => {
  assert.equal(sanitizeClientSecret("test-secret\r\n-value"), "test-secret-value");
});

test("sanitizeClientSecret: strips wrapping double quotes", () => {
  assert.equal(sanitizeClientSecret('"test-secret-value"'), "test-secret-value");
});

test("sanitizeClientSecret: strips wrapping single quotes", () => {
  assert.equal(sanitizeClientSecret("'test-secret-value'"), "test-secret-value");
});

test("sanitizeClientSecret: strips a KEY= prefix", () => {
  assert.equal(
    sanitizeClientSecret("PRODUCTBOARD_OAUTH_CLIENT_SECRET=test-secret-value"),
    "test-secret-value"
  );
});

test("sanitizeClientSecret: strips a full JSON fragment as pasted from the wiki", () => {
  assert.equal(
    sanitizeClientSecret('"PRODUCTBOARD_OAUTH_CLIENT_SECRET": "test-secret-value"'),
    "test-secret-value"
  );
});

test("sanitizeClientSecret: strips a JSON fragment with a trailing comma", () => {
  assert.equal(
    sanitizeClientSecret('"PRODUCTBOARD_OAUTH_CLIENT_SECRET": "test-secret-value",'),
    "test-secret-value"
  );
});

test("sanitizeClientSecret: is case-insensitive about the key name", () => {
  assert.equal(
    sanitizeClientSecret("productboard_oauth_client_secret: test-secret-value"),
    "test-secret-value"
  );
});

test("sanitizeClientSecret: returns undefined for an empty string", () => {
  assert.equal(sanitizeClientSecret(""), undefined);
});

test("sanitizeClientSecret: returns undefined for whitespace only", () => {
  assert.equal(sanitizeClientSecret("   \r\n  "), undefined);
});

test("sanitizeClientSecret: returns undefined for empty quotes", () => {
  assert.equal(sanitizeClientSecret('""'), undefined);
});

test("sanitizeClientSecret: leaves an embedded equals sign intact", () => {
  assert.equal(sanitizeClientSecret("abc=def"), "abc=def");
});
