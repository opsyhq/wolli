import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/workflow/schema.ts",
  out: "./drizzle",
});
