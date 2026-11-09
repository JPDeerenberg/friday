import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  subscriptionsHref,
  buildSubscribeBody,
  canSubscribe,
  canUnsubscribe,
  withSubscription,
  type SubscribableElement,
} from "./activities.ts";

const LINKS = [
  { Rel: "Self", Href: "/api/personen/1/activiteiten/2/onderdelen/3" },
  { Rel: "Subscriptions", Href: "/api/personen/1/activiteiten/2/onderdelen/3/inschrijvingen" },
];

function element(over: Partial<SubscribableElement> = {}): SubscribableElement {
  return {
    Id: 3,
    ActiviteitId: 2,
    IsIngeschreven: false,
    IsVerplichtIngeschreven: false,
    IsOpInTeSchrijven: true,
    AantalPlaatsenBeschikbaar: 5,
    Links: LINKS,
    ...over,
  };
}

describe("activity sign-up", () => {
  it("finds the Subscriptions link", () => {
    assert.equal(subscriptionsHref(LINKS), "/api/personen/1/activiteiten/2/onderdelen/3/inschrijvingen");
    assert.equal(subscriptionsHref([{ Rel: "subscriptions", Href: "/x" }]), "/x");
    assert.equal(subscriptionsHref([{ Rel: "Self", Href: "/y" }]), null);
    assert.equal(subscriptionsHref(null), null);
  });

  it("builds the body Magister expects", () => {
    assert.deepEqual(buildSubscribeBody(10, 20, 30), {
      persoonId: 10,
      activiteitId: 20,
      onderdeelId: 30,
    });
  });

  it("offers sign-up only when it is open, we are not in yet and there is a link", () => {
    assert.equal(canSubscribe(element()), true);
    assert.equal(canSubscribe(element({ IsIngeschreven: true })), false);
    assert.equal(canSubscribe(element({ IsOpInTeSchrijven: false })), false);
    assert.equal(canSubscribe(element({ Links: [] })), false);
  });

  it("offers sign-out for voluntary sign-ups only", () => {
    assert.equal(canUnsubscribe(element({ IsIngeschreven: true })), true);
    assert.equal(canUnsubscribe(element({ IsIngeschreven: true, IsVerplichtIngeschreven: true })), false);
    assert.equal(canUnsubscribe(element()), false);
    assert.equal(canUnsubscribe(element({ IsIngeschreven: true, Links: null })), false);
  });

  it("updates the element optimistically without going below zero", () => {
    const joined = withSubscription(element(), true);
    assert.equal(joined.IsIngeschreven, true);
    assert.equal(joined.AantalPlaatsenBeschikbaar, 4);
    const left = withSubscription(joined, false);
    assert.equal(left.IsIngeschreven, false);
    assert.equal(left.AantalPlaatsenBeschikbaar, 5);
    assert.equal(withSubscription(element({ AantalPlaatsenBeschikbaar: 0 }), true).AantalPlaatsenBeschikbaar, 0);
  });

  it("returns the same object when nothing changes", () => {
    const e = element({ IsIngeschreven: true });
    assert.equal(withSubscription(e, true), e);
  });
});
