import { test, expect } from "bun:test";
import { esc } from "../src/bot/format";

test("esc escapes the three HTML-significant characters only", () => {
  expect(esc("Соус <Tom & Jerry>")).toBe("Соус &lt;Tom &amp; Jerry&gt;");
  expect(esc("борщ")).toBe("борщ");
});
