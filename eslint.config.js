import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["dist/**", "out/**"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts"],
        rules: {
            "@typescript-eslint/no-non-null-assertion": "off",
        },
    },
    {
        // src/login-overlay.js is injected into the login window's page rather
        // than executed in the main process, so it sees browser globals and no
        // Node ones. Everything else it touches hangs off `window`.
        files: ["src/login-overlay.js"],
        languageOptions: {
            globals: {
                window: "readonly",
            },
        },
    }
);
