
import { connect } from "../src";
import { expect, it } from "vitest";
import fetchMock from 'fetch-mock';


fetchMock.config.allowRelativeUrls = true

const userSchema = {
  summary: "Fetch the current user",
  response: {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "number" },
      name: { type: "string" },
    },
  },
};

it.skip("example", async () => {
  fetchMock.mockGlobal();
  const mockClient = await connect({
    filePath: __filename,
    // Note: Don't pass projectRoot here - let it be auto-detected from filePath
    // Passing process.cwd() can cause project mismatch when tests run from different directories
    timeout: 10 * 60 * 1000,
  });

  const metadata = {
    schemaUrl: "https://example.com/openapi.json#/paths/~1user/get",
    schema: userSchema,
    instructions: "Respond with a single user described by the schema.",
  };

  fetchMock.get("http://example.com/user", async () => {
    const response = await mockClient.requestMock("http://example.com/user", "GET", { metadata }) // add mock via mock-mcp
    return response.data
  });
  const result = await fetch("http://example.com/user");
  const data = await result.json();
  expect(data).toEqual({ id: 1, name: "Jane" });
}, 10 * 60 * 1000);