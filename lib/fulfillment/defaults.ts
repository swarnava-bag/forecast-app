/**
 * Starting configuration, copied from "Fulfillment Dashboard Nov-26" workbook
 * (Mapper, SLA & WH Calendar, Pending Orders reason mapping, Dashboard C5/C6).
 * Used to seed the database and as a fallback when a table is still empty.
 */
import type { FulfillmentConfig } from "./engine";

export const DEFAULT_CONFIG: FulfillmentConfig = {
  cutoff: "15:00",
  credDefaultHours: null,
  channelMap: [
    { channelName: "JIOMART3PYB", l1: "JioMart", l2: "JioMartEZBLR" },
    { channelName: "AMAZON_FLEX_EMIZA3", l1: "Amazon", l2: "AZEZBLR" },
    { channelName: "PopClub_New", l1: "PopClub", l2: "PopClub" },
    { channelName: "FLIPKART_Emiza2", l1: "Flipkart", l2: "FKEZBLR" },
    { channelName: "MEESHO", l1: "Meesho", l2: "MeeshoEZBLR" },
    { channelName: "SMYTTEN", l1: "Smytten", l2: "Smytten" },
    { channelName: "HYUGALIFE", l1: "Hyugalife", l2: "Hyugalife" },
    { channelName: "Yoga_Bars_Website_Shopify", l1: "Website", l2: "Website" },
    { channelName: "CRED", l1: "CRED", l2: "CRED" },
    { channelName: "CUSTOM_B2B", l1: ">70%", l2: ">70%" },
    { channelName: "KINDLIFE", l1: "Kindlife", l2: "Kindlife" },
    { channelName: "CUSTOM_HEALTHKART", l1: "HealthKart", l2: "HealthKart" },
    { channelName: "PHARMEASY", l1: "Pharmeasy", l2: "Pharmeasy" },
    { channelName: "CUSTOM", l1: "Replacement", l2: "Replacement" },
    { channelName: "AMAZON_FLEX_Farukhnagar", l1: "Amazon", l2: "AZEZDEL" },
    { channelName: "FLIPKART_Farrukhnagar", l1: "Flipkart", l2: "FKEZDEL" },
    { channelName: "MEESHO_Farukhnagar", l1: "Meesho", l2: "MeeshoEZDEL" },
    { channelName: "FLIPKART_Bhiwandi", l1: "Flipkart", l2: "FKEZBHI" },
    { channelName: "FLIPKART_Hoskote_Prozo", l1: "Flipkart", l2: "FKProzo" },
    { channelName: "AMAZON_FLEX_Hoskote_Prozo", l1: "Amazon", l2: "AZProzo" },
  ],
  closedDays: [
    ...["2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12"]
      .map((m) => ({ date: `${m}-01`, warehouse: null, remarks: "Monthly closure (1st)" })),
    { date: "2026-11-08", warehouse: null, remarks: "Diwali" },
  ],
  credSla: [],
  reasons: [
    { statusKey: "ON_HOLD", reason: "Order on hold / pending verification – release in Uniware" },
    { statusKey: "ALTERNATE_ACCEPTED", reason: "Alternate SKU line – ignored (should not appear)" },
    { statusKey: "ALTERNATE_SUGGESTED", reason: "Alternate SKU suggested – awaiting acceptance" },
    { statusKey: "UNFULFILLABLE", reason: "Inventory not available (Unfulfillable)" },
    { statusKey: "FULFILLABLE", reason: "Inventory allocated – shipping package not yet created" },
    { statusKey: "CREATED", reason: "Package created – picking not started" },
    { statusKey: "PICKING", reason: "Picking in progress" },
    { statusKey: "PICKED", reason: "Picked – awaiting invoicing / packing" },
    { statusKey: "PACKED", reason: "Packed – awaiting manifest" },
    { statusKey: "READY_TO_SHIP", reason: "Ready to ship – awaiting manifest / courier handover" },
    { statusKey: "MANIFESTED", reason: "Manifested – awaiting courier pickup (no dispatch date yet)" },
  ],
};
