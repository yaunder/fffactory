/**
 * Port: asks the operator to approve a plan they are shown. Declining, or having no one
 * to ask, is `false`: nothing is ever approved by default.
 */
export interface Approval {
  approve(plan: readonly string[]): Promise<boolean>;
}
