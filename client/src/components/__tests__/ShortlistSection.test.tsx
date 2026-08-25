/* G-8.4 — the shortlist participation section.
 *
 * The component's whole job is keeping FOUR answers apart, two of which render
 * an empty list and would otherwise look identical:
 *
 *   1. no registration number      → we did not look
 *   2. appearances found            → these are the lists
 *   3. checked, none matched        → we looked at N and you were not on them
 *   4. nothing to check             → you have no shortlists yet
 *
 * Cases 3 and 4 are the pair that matters. Showing "no match" to a student whose
 * attachments contain no shortlist at all would tell them something false about
 * their applications, so the assertions below pin that the wording differs and
 * that neither borrows the other's claim.
 *
 * The API client is mocked at the module boundary — `userApi.test.ts` pins the
 * request shape, and re-asserting it here would test the same contract twice.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const getShortlistParticipation = vi.fn();

vi.mock("../../api/userApi", () => ({
  getShortlistParticipation: () => getShortlistParticipation(),
}));

import ShortlistSection from "../ShortlistSection";

const participation = (overrides: Record<string, unknown> = {}) => ({
  registrationNumber: "20231234",
  shortlistsChecked: 0,
  appearsOn: [],
  ...overrides,
});

/* Renders and waits for the initial load to settle, so no test races the
   effect. */
const renderLoaded = async () => {
  render(<ShortlistSection />);
  await waitFor(() => expect(getShortlistParticipation).toHaveBeenCalled());
};

const bodyText = () => document.body.textContent ?? "";

beforeEach(() => {
  getShortlistParticipation.mockReset();
  getShortlistParticipation.mockResolvedValue(participation());
});

describe("1. no registration number", () => {
  it("explains what setting one enables", async () => {
    getShortlistParticipation.mockResolvedValue(
      participation({ registrationNumber: null }),
    );

    await renderLoaded();

    // Phrased as what a number ENABLES, not as something missing: the field is
    // optional and this must not read as a nag.
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /add your registration number/i,
      ),
    );
  });

  it("does not claim anything was checked", async () => {
    getShortlistParticipation.mockResolvedValue(
      participation({ registrationNumber: null, shortlistsChecked: 3 }),
    );

    await renderLoaded();

    // Nothing was looked up, so no result may be implied — even if the server
    // reported a count.
    await waitFor(() => expect(bodyText()).toMatch(/add your registration/i));
    expect(bodyText()).not.toMatch(/not found|you appear/i);
  });

  it("treats a blank number the same as none", async () => {
    getShortlistParticipation.mockResolvedValue(
      participation({ registrationNumber: "   " }),
    );

    await renderLoaded();

    await waitFor(() => expect(bodyText()).toMatch(/add your registration/i));
  });
});

describe("2. appearances found", () => {
  it("reports the matching shortlists", async () => {
    getShortlistParticipation.mockResolvedValue(
      participation({
        shortlistsChecked: 3,
        appearsOn: [{ attachmentId: 11 }, { attachmentId: 12 }],
      }),
    );

    await renderLoaded();

    await waitFor(() =>
      expect(bodyText()).toMatch(/you appear on 2 shortlists/i),
    );
    expect(bodyText()).toContain("Attachment #11");
    expect(bodyText()).toContain("Attachment #12");
  });

  it("uses the singular for one match", async () => {
    getShortlistParticipation.mockResolvedValue(
      participation({ shortlistsChecked: 1, appearsOn: [{ attachmentId: 11 }] }),
    );

    await renderLoaded();

    await waitFor(() => expect(bodyText()).toMatch(/you appear on 1 shortlist/i));
    expect(bodyText()).not.toMatch(/1 shortlists/i);
  });

  it("does not also claim the number was not found", async () => {
    getShortlistParticipation.mockResolvedValue(
      participation({ shortlistsChecked: 2, appearsOn: [{ attachmentId: 11 }] }),
    );

    await renderLoaded();

    await waitFor(() => expect(bodyText()).toMatch(/you appear on/i));
    expect(bodyText()).not.toMatch(/was not found/i);
  });
});

describe("3. checked, and the number was not on them", () => {
  it("says so explicitly, with the count", async () => {
    getShortlistParticipation.mockResolvedValue(
      participation({ shortlistsChecked: 4, appearsOn: [] }),
    );

    await renderLoaded();

    // The count makes the answer checkable rather than merely asserted.
    await waitFor(() =>
      expect(bodyText()).toMatch(/not found on any of the 4 shortlists checked/i),
    );
  });

  it("uses the singular for one shortlist", async () => {
    getShortlistParticipation.mockResolvedValue(
      participation({ shortlistsChecked: 1, appearsOn: [] }),
    );

    await renderLoaded();

    await waitFor(() =>
      expect(bodyText()).toMatch(/not found on the 1 shortlist checked/i),
    );
  });

  it("does not say there was nothing to check", async () => {
    getShortlistParticipation.mockResolvedValue(
      participation({ shortlistsChecked: 4, appearsOn: [] }),
    );

    await renderLoaded();

    // THE DISTINCTION THAT CARRIES THIS FILE, from the other side.
    await waitFor(() => expect(bodyText()).toMatch(/not found/i));
    expect(bodyText()).not.toMatch(/nothing to check/i);
  });
});

describe("4. nothing to check", () => {
  it("says no shortlists have been found yet", async () => {
    getShortlistParticipation.mockResolvedValue(
      participation({ shortlistsChecked: 0, appearsOn: [] }),
    );

    await renderLoaded();

    await waitFor(() =>
      expect(bodyText()).toMatch(/no shortlists have been found/i),
    );
  });

  it("never claims the number was not found", async () => {
    getShortlistParticipation.mockResolvedValue(
      participation({ shortlistsChecked: 0, appearsOn: [] }),
    );

    await renderLoaded();

    // THE DISTINCTION THAT CARRIES THIS FILE. "We checked and you were not on
    // them" is a claim about the student's applications; saying it when no
    // shortlist has ever been processed would be false.
    await waitFor(() => expect(bodyText()).toMatch(/nothing to check/i));
    expect(bodyText()).not.toMatch(/not found on/i);
  });
});

describe("no other student's data is rendered", () => {
  it("shows attachment ids and nothing about participants", async () => {
    getShortlistParticipation.mockResolvedValue(
      participation({ shortlistsChecked: 1, appearsOn: [{ attachmentId: 11 }] }),
    );

    await renderLoaded();

    await waitFor(() => expect(bodyText()).toContain("Attachment #11"));

    // The API sends no participant attribute at all, so there is nothing to
    // render even by accident. Asserted anyway, because this is the property a
    // future "show me who else" change would quietly break.
    for (const leaked of ["roll", "seat", "Student", "name"]) {
      expect(bodyText().toLowerCase()).not.toContain(leaked.toLowerCase());
    }
  });
});

describe("failures stay out of the way", () => {
  it("renders nothing when the lookup fails", async () => {
    getShortlistParticipation.mockRejectedValue(
      Object.assign(new Error("Request failed"), { status: 401 }),
    );

    const { container } = render(<ShortlistSection />);
    await waitFor(() => expect(getShortlistParticipation).toHaveBeenCalled());

    // The Dashboard already reports session state once; a second banner saying
    // the same thing is noise.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("never blocks the application", async () => {
    await renderLoaded();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
