/** Port: the operator at the terminal, and standard input. */
export interface OperatorPrompt {
  /** Whether standard input is a terminal an operator answers at, rather than a pipe or file. */
  readonly interactive: boolean;
  /** Asks on the terminal and reads one line, echoed. Undefined when input ends first. */
  ask(question: string): Promise<string | undefined>;
  /**
   * Asks on the terminal and reads one line without echoing it. Undefined when the operator
   * cancels (Ctrl-C, or Ctrl-D on an empty line) or input ends first.
   */
  askHidden(question: string): Promise<string | undefined>;
  /** All of standard input, or undefined when it is longer than `limit` bytes. */
  readInput(limit: number): Promise<string | undefined>;
}
