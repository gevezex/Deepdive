// Every area of the interface keeps its own texts in one file, in all three languages side by side. English is
// leading: Dutch and Turkish must have exactly the same keys, or the build fails.
export type Lang = "en" | "nl" | "tr";

export type Messages = Record<string, string>;

export function defineMessages<T extends Messages>(messages: { en: T; nl: { [K in keyof T]: string }; tr: { [K in keyof T]: string } }) {
  return messages;
}
