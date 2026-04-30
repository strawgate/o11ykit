import { describe, expect, it } from "vitest";

import { LIBRARIES } from "../js/gallery-data.js";
import { hasPackageRenderer } from "../js/gallery-renderers.js";

describe("chart gallery package renderers", () => {
  it("requires every gallery library to have a native package renderer", () => {
    expect(LIBRARIES.map((library) => library.id).filter(hasPackageRenderer)).toEqual(
      LIBRARIES.map((library) => library.id)
    );
  });
});
