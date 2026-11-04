import { describe, expect, test } from "bun:test";
import { isReservedNip05Name, validateNip05Name } from "./name";

describe("validateNip05Name", () => {
  test("normalizes a valid name to lowercase", () => {
    expect(validateNip05Name("AliceX")).toEqual({
      valid: true,
      name: "alicex",
    });
  });

  test.each([["ab", "two characters"]])("rejects %s (%s)", (input) => {
    expect(validateNip05Name(input)).toEqual({ valid: false, name: input });
  });

  // G1: a dotted name would be claimed by the ATProto resolver in the
  // first-match-wins registry, so `/@alice.dev` would resolve to the wrong
  // person. Dots must be rejected outright, at every position.
  test.each([
    ["alice.dev", "collides with the ATProto handle shape"],
    ["alice.smith", "collides with the ATProto handle shape"],
    ["alice.eth", "collides with the ENS handle shape"],
    [".abcdef", "leading dot"],
    ["abcdef.", "trailing dot"],
    ["ab..cdef", "consecutive dots"],
  ])("rejects %s (%s)", (input) => {
    expect(validateNip05Name(input).valid).toBe(false);
  });

  test.each([
    ["a".repeat(31), "more than 30 characters"],
    ["alice-smith", "hyphens are not issued in v1"],
    ["alice_smith", "underscores are not issued in v1"],
    ["abc+def", "characters outside the allowed set"],
    ["嗨你好嗨你好", "non-ASCII characters"],
    [42, "non-string values"],
  ])("rejects %s (%s)", (input) => {
    expect(validateNip05Name(input).valid).toBe(false);
  });

  test("classifies reserved names independently from syntax", () => {
    expect(isReservedNip05Name("ADMIN")).toBe(true);
    expect(isReservedNip05Name("edit")).toBe(true);
    expect(isReservedNip05Name("alicex")).toBe(false);
  });

  test.each([
    "abc",
    "abcde",
    "abcdef",
    "a".repeat(30),
    "alice1",
  ])("accepts the valid boundary %s", (input) => {
    expect(validateNip05Name(input)).toEqual({
      valid: true,
      name: input,
    });
  });
});
