/**
 * Pure helpers for signing up for activity elements ("onderdelen").
 * Magister's flow (same as Discipulus): every element carries a `Subscriptions`
 * link; POST a small record to it to sign up, DELETE it to sign out again.
 */

export interface ActivityLink {
  Rel: string;
  Href: string;
}

export interface SubscribableElement {
  Id: number;
  ActiviteitId?: number;
  IsIngeschreven: boolean;
  IsVerplichtIngeschreven?: boolean;
  IsOpInTeSchrijven: boolean;
  AantalPlaatsenBeschikbaar: number;
  Links?: ReadonlyArray<ActivityLink> | null;
}

export function subscriptionsHref(
  links: ReadonlyArray<ActivityLink> | null | undefined,
): string | null {
  const found = (links ?? []).find((l) => (l.Rel ?? "").toLowerCase() === "subscriptions");
  return found?.Href ? found.Href : null;
}

export function buildSubscribeBody(personId: number, activityId: number, elementId: number) {
  return { persoonId: personId, activiteitId: activityId, onderdeelId: elementId };
}

/** Sign-up is offered when Magister says it is open and we are not in yet. */
export function canSubscribe(e: SubscribableElement): boolean {
  return e.IsOpInTeSchrijven && !e.IsIngeschreven && !!subscriptionsHref(e.Links);
}

/** Signing out is offered for voluntary sign-ups only. */
export function canUnsubscribe(e: SubscribableElement): boolean {
  return e.IsIngeschreven && !e.IsVerplichtIngeschreven && !!subscriptionsHref(e.Links);
}

/** The element as it looks right after a successful sign-up/sign-out (before a refresh). */
export function withSubscription<T extends SubscribableElement>(e: T, subscribed: boolean): T {
  if (e.IsIngeschreven === subscribed) return e;
  return {
    ...e,
    IsIngeschreven: subscribed,
    AantalPlaatsenBeschikbaar: Math.max(0, e.AantalPlaatsenBeschikbaar + (subscribed ? -1 : 1)),
  };
}
