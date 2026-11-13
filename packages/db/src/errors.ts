// Use cases throw stable error codes, never UI text. The API maps `.code` to its own stable
// error code set; a client translates codes to copy, never the reverse.
export class UseCaseError<C extends string = string> extends Error {
  override readonly name = "UseCaseError";

  constructor(readonly code: C) {
    super(code);
  }
}
