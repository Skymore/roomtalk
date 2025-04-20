import { heroui } from "@heroui/react";

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      typography: (theme) => ({
        DEFAULT: {
          css: {
            /* 段落与标题更紧凑 */
            "p": {
              marginTop: theme("spacing.1"),
              marginBottom: theme("spacing.1"),
            },
            "h1,h2,h3,h4,h5,h6": {
              marginTop: theme("spacing.2"),
              marginBottom: theme("spacing.2"),
            },

            /* 代码块 (pre) */
            "pre": {
              backgroundColor: theme("colors.white"),
              borderRadius: theme("borderRadius.lg"),
              padding: theme("spacing.4"),
              marginTop: theme("spacing.10"),
              marginBottom: theme("spacing.10"),
              overflowX: "auto",
            },
            /* 行内 code */
            "code": {
              backgroundColor: theme("colors.gray.200"),
              padding: `${theme("spacing.0.5")} ${theme("spacing.1")}`,
              borderRadius: theme("borderRadius.md"),
            },
          },
        },
        dark: {
          css: {
            /* 深色模式下 pre 背景 */
            "pre": {
              backgroundColor: theme("colors.gray.800"),
            },
            /* 深色模式下 inline code 背景 */
            "code": {
              backgroundColor: theme("colors.gray.700"),
            },
          },
        },
      }),
    },
  },
  darkMode: "class",
  plugins: [
    heroui(),
    require("@tailwindcss/typography"),
    // require('@tailwindcss/forms'),
    require("@tailwindcss/aspect-ratio"),
  ],
};
