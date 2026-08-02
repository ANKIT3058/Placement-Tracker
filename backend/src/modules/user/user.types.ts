// The identity claims this system accepts from Google, after the ID token has
// been cryptographically verified. Nothing outside `verifyGoogleIdToken`
// constructs one of these, so a value of this type always represents a claim
// Google signed — never something read off an unverified request.
export type GoogleIdentity = {
  // The Google subject identifier: opaque, immutable, and the only field this
  // system authenticates on (RFC-001 §8.1). Never `email`, which a Workspace
  // administrator can rename or reassign to a different person.
  googleSub: string;

  email: string;
  emailVerified: boolean;

  name: string | null;
  imageUrl: string | null;
};
