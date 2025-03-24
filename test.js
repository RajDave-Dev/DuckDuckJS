import { DuckDuck } from "duckduckjs"

const messages = [
  { role: "user", content: "Explain the use of Typescript vs Javascript in brief, explain everything." }
];
const chat = new DuckDuck();

(async () => {
  try {
    for await (const message of chat.chatYield(messages, "claude-3-haiku")) {
      console.log(message);
    }
    console.log(await chat.text("Typescript"));
  } catch (error) {
    console.error('Error during chat:', error);
  }
})();