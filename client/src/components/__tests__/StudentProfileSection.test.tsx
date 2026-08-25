/* G-8.3 — the student profile section.
 *
 * A registration number is optional campus information, never identity. The
 * assertions that carry this file are the ones about what the section refuses
 * to do: it never blocks the application, it imposes no format rule, and it
 * never says who holds a number that is already taken.
 *
 * The API client is mocked at the module boundary — `userApi.test.ts` already
 * pins the request shape, and re-asserting it through the component would test
 * the same contract twice while making these tests about fetch rather than
 * about behaviour.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const getStudentProfile = vi.fn();
const updateStudentProfile = vi.fn();

vi.mock("../../api/userApi", () => ({
  getStudentProfile: () => getStudentProfile(),
  updateStudentProfile: (value: string | null) => updateStudentProfile(value),
}));

import StudentProfileSection from "../StudentProfileSection";

const apiError = (status: number) =>
  Object.assign(new Error(`Request failed with status ${status}`), { status });

const field = () => screen.getByRole("textbox");
/* Matches both labels: the button reads "Save" at rest and "Saving…" in
   flight, and "Saving" does not contain the substring "save". */
const saveButton = () => screen.getByRole("button", { name: /^sav/i });
const clearButton = () => screen.getByRole("button", { name: /clear/i });

/* Renders and waits for the initial load to settle, so no test races the
   effect. */
const renderLoaded = async () => {
  render(<StudentProfileSection />);
  await waitFor(() => expect(getStudentProfile).toHaveBeenCalled());
};

beforeEach(() => {
  getStudentProfile.mockReset();
  updateStudentProfile.mockReset();
  getStudentProfile.mockResolvedValue({ registrationNumber: null });
  updateStudentProfile.mockImplementation(async (value: string | null) => ({
    registrationNumber: value,
  }));
});

describe("reading the current number", () => {
  it("shows an existing registration number", async () => {
    getStudentProfile.mockResolvedValue({ registrationNumber: "20231234" });

    await renderLoaded();

    await waitFor(() => expect(field()).toHaveValue("20231234"));
  });

  it("shows an empty field for a student who has never set one", async () => {
    getStudentProfile.mockResolvedValue({ registrationNumber: null });

    await renderLoaded();

    // Presented as a normal state, not an error and not something to fix.
    await waitFor(() => expect(field()).toHaveValue(""));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders nothing at all when the profile cannot be loaded", async () => {
    getStudentProfile.mockRejectedValue(apiError(401));

    const { container } = render(<StudentProfileSection />);
    await waitFor(() => expect(getStudentProfile).toHaveBeenCalled());

    // The Dashboard already reports session state once; a second banner saying
    // the same thing is noise. A section that cannot know stays out of the way.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe("the section never blocks the application", () => {
  it("offers no modal, dialog or required field", async () => {
    getStudentProfile.mockResolvedValue({ registrationNumber: null });

    await renderLoaded();

    // THE INVARIANT THAT MATTERS MOST. Off-campus opportunities carry no
    // registration number, so a student who never sets one must see an
    // application that behaves identically — no gate, no nag, no onboarding.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(field()).not.toBeRequired();
  });

  it("does not offer Clear when there is nothing to clear", async () => {
    getStudentProfile.mockResolvedValue({ registrationNumber: null });

    await renderLoaded();

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /clear/i })).toBeNull(),
    );
  });
});

describe("saving", () => {
  // NO FORMAT RULE. Each of these reaches the API untouched — the component has
  // no opinion about what a registration number looks like, and imposing one
  // here would refuse students whose number is valid at their institution.
  it.each([
    "20231234",
    "2023ABCD",
    "ABC-123",
    "BTECH/2023/42",
    "anything",
    "21BCE1234",
    "MiXeDcAsE",
  ])("accepts %o and sends it unchanged", async (value) => {
    getStudentProfile.mockResolvedValue({ registrationNumber: null });

    await renderLoaded();
    fireEvent.change(field(), { target: { value: value } });
    fireEvent.click(saveButton());

    // No case folding and no client-side rewriting: exactly what was typed.
    await waitFor(() => expect(updateStudentProfile).toHaveBeenCalledWith(value));
  });

  it("confirms a successful save", async () => {
    await renderLoaded();
    fireEvent.change(field(), { target: { value: "20231234" } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/saved/i),
    );
  });

  it("sends the value untrimmed, exactly as typed", async () => {
    updateStudentProfile.mockResolvedValue({ registrationNumber: "padded" });

    await renderLoaded();
    fireEvent.change(field(), { target: { value: "  padded  " } });
    fireEvent.click(saveButton());

    // THE CLIENT DOES NOT NORMALIZE. Trimming belongs to the server and to
    // nothing else — doing it here as well would be a second implementation of
    // one rule, free to drift from the first. The component trims a COPY of the
    // draft to decide whether Save is meaningful, and that copy must never
    // become the value that is sent.
    await waitFor(() =>
      expect(updateStudentProfile).toHaveBeenCalledWith("  padded  "),
    );
  });

  it("shows the stored value the server returned, not the typed one", async () => {
    updateStudentProfile.mockResolvedValue({ registrationNumber: "20231234" });

    await renderLoaded();
    // The server trims; echoing the draft back would display something subtly
    // different from what was actually stored.
    fireEvent.change(field(), { target: { value: "  20231234  " } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(field()).toHaveValue("20231234"));
  });

  it("disables Save while a request is in flight", async () => {
    let release!: () => void;
    updateStudentProfile.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ registrationNumber: "20231234" });
        }),
    );

    await renderLoaded();
    fireEvent.change(field(), { target: { value: "20231234" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(saveButton()).toBeDisabled());

    release();

    await waitFor(() => expect(updateStudentProfile).toHaveBeenCalledTimes(1));
  });

  it("does not save an empty field", async () => {
    getStudentProfile.mockResolvedValue({ registrationNumber: null });

    await renderLoaded();

    // Nothing typed and nothing stored: there is no change to submit, and a
    // request here would be a clear the user never asked for.
    await waitFor(() => expect(saveButton()).toBeDisabled());
    expect(updateStudentProfile).not.toHaveBeenCalled();
  });
});

describe("clearing", () => {
  it("sends null rather than an empty string", async () => {
    getStudentProfile.mockResolvedValue({ registrationNumber: "20231234" });
    updateStudentProfile.mockResolvedValue({ registrationNumber: null });

    await renderLoaded();
    await waitFor(() => expect(clearButton()).toBeEnabled());
    fireEvent.click(clearButton());

    // The server treats an omitted field as "change nothing", so a clear has to
    // say null explicitly.
    await waitFor(() => expect(updateStudentProfile).toHaveBeenCalledWith(null));
  });

  it("empties the field and confirms", async () => {
    getStudentProfile.mockResolvedValue({ registrationNumber: "20231234" });
    updateStudentProfile.mockResolvedValue({ registrationNumber: null });

    await renderLoaded();
    await waitFor(() => expect(clearButton()).toBeEnabled());
    fireEvent.click(clearButton());

    await waitFor(() => expect(field()).toHaveValue(""));
    expect(screen.getByRole("status")).toHaveTextContent(/cleared/i);
  });
});

describe("a number already taken by someone else", () => {
  it("says it is in use", async () => {
    updateStudentProfile.mockRejectedValue(apiError(409));

    await renderLoaded();
    fireEvent.change(field(), { target: { value: "20231234" } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/already in use/i),
    );
  });

  it("reveals nothing about who holds it", async () => {
    updateStudentProfile.mockRejectedValue(apiError(409));

    await renderLoaded();
    fireEvent.change(field(), { target: { value: "20231234" } });
    fireEvent.click(saveButton());

    // Otherwise this field becomes a way to test registration numbers against
    // the user base one submission at a time. The message names no account, no
    // email and no id.
    const message = (await screen.findByRole("alert")).textContent ?? "";

    expect(message).not.toMatch(/user|account|owner|belongs|@|\bid\b/i);
  });
});

describe("ordinary failures", () => {
  it.each([
    ["a server error", 500],
    ["an expired session", 401],
  ])("reports %s without claiming success", async (_label, status) => {
    updateStudentProfile.mockRejectedValue(apiError(status));

    await renderLoaded();
    fireEvent.change(field(), { target: { value: "20231234" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("reports an unreachable server distinctly from a refusal", async () => {
    updateStudentProfile.mockRejectedValue(new TypeError("Failed to fetch"));

    await renderLoaded();
    fireEvent.change(field(), { target: { value: "20231234" } });
    fireEvent.click(saveButton());

    // A network failure carries no status. Reporting it as a server refusal
    // would send someone off to fix the wrong thing.
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/connection/i),
    );
  });
});
