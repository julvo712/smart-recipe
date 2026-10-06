import { describe, expect, it, vi } from "vitest";
import { MonsieurCuisineSmartClient } from "../src/mc/client.js";
import type { AuthProvider } from "../src/mc/auth.js";

const authProvider: AuthProvider = {
  getSession: async () => ({ cookie: "MC_COOKIE=test", source: "config" } as never)
};

const RECIPE_DETAIL = { id: 1048, title: "Tomato Soup" };

function clientFor(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }) as unknown as Response);
  return { client: new MonsieurCuisineSmartClient({ authProvider, fetch: fetchMock as never }), fetchMock };
}

describe("MonsieurCuisineSmartClient recipe unwrap tolerance", () => {
  it("reads getRecipe from the live-verified wrapper shape data.recipe (object)", async () => {
    const { client } = clientFor({ code: 0, data: { recipe: RECIPE_DETAIL } });
    await client.getRecipe(1048);
  });

  it("tolerates data.recipe as a one-element array", async () => {
    const { client, fetchMock } = clientFor({ code: 0, data: { recipe: [RECIPE_DETAIL] } });
    await client.getRecipe(1048);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tolerates createRecipe with a wrapped one-element recipe array", async () => {
    const { client } = clientFor({ code: 0, data: { recipe: [RECIPE_DETAIL] } });
    await expect(client.getRecipe(1048)).resolves.toBeDefined();
  });
});