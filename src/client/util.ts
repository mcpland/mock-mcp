export const isEnabled = () => {
    return process.env.MOCK_MCP !== undefined && process.env.MOCK_MCP !== "0";
};