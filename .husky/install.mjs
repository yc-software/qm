if (process.env.CI === "true" || process.env.NODE_ENV === "production" || process.env.npm_config_omit === "dev") {
  process.exit(0);
}

const husky = (await import("husky")).default;
console.log(husky());
