import type { MessageCategory } from "./types";

export const CATEGORY_LABEL: Record<MessageCategory, string> = {
  building_access: "Building access",
  wrong_address: "Wrong address",
  missing_bag: "Missing / wrong bag",
  stuck_at_pickup: "Stuck at pickup",
  stop_order: "Stop-order confusion",
  driver_quiet: "Driver went quiet",
  wismo: "Where's my order?",
  pod_request: "Proof of delivery",
  pay_question: "Pay question",
  other: "Other",
};
