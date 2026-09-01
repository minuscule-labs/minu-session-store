import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/catalog/schema.ts",
  out: "./drizzle",
});
