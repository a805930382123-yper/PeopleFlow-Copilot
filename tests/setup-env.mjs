if (!process.env.LLM_PROVIDER && !process.env.LLM_API_KEY) process.env.LLM_PROVIDER = "classroom-fixture";
if (process.env.LLM_PROVIDER === "classroom-fixture") process.env.LLM_MOCK_MODE = "true";
