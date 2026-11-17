// Own config so vitest ignores the web app's root vite/postcss configs (they need packages the SDK does not install).
export default { css: { postcss: {} }, test: {} };
