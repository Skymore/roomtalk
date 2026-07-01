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
      colors: {
        paper: "#f5f4ed",
        ivory: "#faf9f5",
        sand: "#e8e6dc",
        warmBorder: "#dedbd0",
        warmText: "#141413",
        warmMuted: "#5e5d59",
        "muted-foreground": "rgb(var(--rt-muted-foreground-rgb) / <alpha-value>)",
        terracotta: "#c96442",
        coral: "#d97757",
        ink: "#30302e",
      },
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
              minWidth: "0",
              maxWidth: "100%",
            },
            /* 行内 code */
            "code": {
              backgroundColor: theme("colors.gray.200"),
              padding: `${theme("spacing.0.5")} ${theme("spacing.1")}`,
              borderRadius: theme("borderRadius.md"),
              minWidth: "0",
              maxWidth: "100%",
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
    heroui({
      themes: {
        light: {
          colors: {
            background: "#f5f4ed",
            foreground: "#141413",
            content1: "#faf9f5",
            content2: "#f0eee6",
            content3: "#e8e6dc",
            content4: "#d1cfc5",
            divider: "#dedbd0",
            focus: "#3898ec",
            primary: {
              DEFAULT: "#30302e",
              foreground: "#faf9f5",
            },
            secondary: {
              DEFAULT: "#c96442",
              foreground: "#faf9f5",
            },
          },
        },
        dark: {
          colors: {
            background: "#141413",
            foreground: "#faf9f5",
            content1: "#1d1d1b",
            content2: "#30302e",
            content3: "#3d3d3a",
            content4: "#4d4c48",
            divider: "#30302e",
            focus: "#3898ec",
            primary: {
              DEFAULT: "#faf9f5",
              foreground: "#141413",
            },
            secondary: {
              DEFAULT: "#d97757",
              foreground: "#141413",
            },
          },
        },
      },
      layout: {
        radius: {
          small: "6px",
          medium: "8px",
          large: "12px",
        },
      },
    }),
    require("@tailwindcss/typography"),
    // require('@tailwindcss/forms'),
    require("@tailwindcss/aspect-ratio"),
  ],
};
