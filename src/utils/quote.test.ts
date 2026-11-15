import { describe, expect, it } from "vitest";
import { EMPTY_CONNECTIONS, type Quote } from "@/types";
import { attachQuote, detachQuote, quoteAttribution, quoteParagraphs } from "./quote";

const buber: Quote = {
  text: "All real living is meeting.\n\nSecond paragraph of the passage.",
  title: "I and Thou",
  author: "Martin Buber",
  page: "11",
  link: "I and Thou#^3fa9c2",
};

describe("attachQuote", () => {
  it("keeps the quote with the connections and adds its link", () => {
    const conn = attachQuote({ ...EMPTY_CONNECTIONS, topics: ["meeting"], links: ["[[Phil Stutz]]"] }, buber);
    expect(conn.quote).toEqual(buber);
    expect(conn.links).toEqual(["[[Phil Stutz]]", "[[I and Thou#^3fa9c2]]"]);
    expect(conn.topics).toEqual(["meeting"]);
  });

  it("does not add a link that is already there", () => {
    const conn = attachQuote({ ...EMPTY_CONNECTIONS, links: ["[[i and thou#^3FA9C2]]"] }, buber);
    expect(conn.links).toEqual(["[[i and thou#^3FA9C2]]"]);
  });

  it("adds no link when the quote has none", () => {
    const conn = attachQuote(EMPTY_CONNECTIONS, { ...buber, link: "" });
    expect(conn.links).toEqual([]);
    expect(conn.quote?.text).toBe(buber.text);
  });

  it("replaces a quote that was attached before, link and all", () => {
    const first = attachQuote(EMPTY_CONNECTIONS, buber);
    const second = attachQuote(first, { ...buber, text: "Another passage.", link: "The Tools#^abc" });
    expect(second.quote?.text).toBe("Another passage.");
    expect(second.links).toEqual(["[[The Tools#^abc]]"]);
  });
});

describe("detachQuote", () => {
  it("removes the quote and the link it brought, and nothing else", () => {
    const conn = detachQuote(attachQuote({ ...EMPTY_CONNECTIONS, links: ["[[Phil Stutz]]"], conversations: ["Ember 2026"] }, buber));
    expect(conn.quote).toBeNull();
    expect(conn.links).toEqual(["[[Phil Stutz]]"]);
    expect(conn.conversations).toEqual(["Ember 2026"]);
  });

  it("leaves connections without a quote alone", () => {
    const conn = { ...EMPTY_CONNECTIONS, links: ["[[Phil Stutz]]"] };
    expect(detachQuote(conn)).toBe(conn);
  });
});

describe("quoteAttribution", () => {
  it("names the author, the book and the page, leaving out what is missing", () => {
    expect(quoteAttribution(buber)).toBe("Martin Buber, I and Thou, p. 11");
    expect(quoteAttribution({ ...buber, author: "" })).toBe("I and Thou, p. 11");
    expect(quoteAttribution({ ...buber, page: "" })).toBe("Martin Buber, I and Thou");
    expect(quoteAttribution({ ...buber, author: "", title: "", page: "" })).toBe("");
  });
});

describe("quoteParagraphs", () => {
  it("splits on blank lines and keeps line breaks inside a paragraph", () => {
    expect(quoteParagraphs(buber)).toEqual(["All real living is meeting.", "Second paragraph of the passage."]);
    expect(quoteParagraphs({ ...buber, text: "one\ntwo\n\n\nthree" })).toEqual(["one\ntwo", "three"]);
  });
});
