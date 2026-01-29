/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef7ff",
          100: "#d9edff",
          200: "#bce0ff",
          300: "#8eccff",
          400: "#59afff",
          500: "#338bff",
          600: "#1a6af5",
          700: "#1354e1",
          800: "#1644b6",
          900: "#183d8f",
          950: "#142757",
        },
      },
    },
  },
  plugins: [],
};
