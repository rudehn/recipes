/// <reference types="vite/client" />

/**
 * The design tokens, parsed out of styles.css at build time by the
 * design-tokens plugin in vite.config.ts.
 */
declare module "virtual:design-tokens" {
  export interface Token {
    name: string;
    value: string;
  }

  export interface TokenGroup {
    name: string;
    tokens: Token[];
  }

  const groups: TokenGroup[];
  export default groups;
}
