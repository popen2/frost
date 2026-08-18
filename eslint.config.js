import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["dist/**", "out/**"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        // .cts too, so src/preload.cts is treated like every other source
        // file rather than silently getting a stricter rule set.
        files: ["**/*.ts", "**/*.cts"],
        rules: {
            "@typescript-eslint/no-non-null-assertion": "off",
        },
    }
);
