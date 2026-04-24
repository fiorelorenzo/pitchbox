ALTER TABLE "campaigns" ADD COLUMN "agent_runner" TEXT NOT NULL DEFAULT 'claude-code';
ALTER TABLE "runs" ADD COLUMN "agent_runner" TEXT NOT NULL DEFAULT 'claude-code';
