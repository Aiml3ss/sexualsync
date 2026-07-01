// ESLint v9 flat config. Next 16 removed the `next lint` CLI; users invoke
// ESLint directly and consume `eslint-config-next` as a flat config array.
import next from "eslint-config-next";

const config = [
  ...next,
];

export default config;
