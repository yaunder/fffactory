import type { PlanReview } from "../domain/plan";

/**
 * Port: asks the operator to approve a plan they are shown, as the review it is: the CLI lays it
 * out. Declining, or having no one to ask, is `false`: nothing is ever approved by default.
 */
export interface Approval {
  approve(review: PlanReview): Promise<boolean>;
}
