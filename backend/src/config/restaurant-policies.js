// Official Hammad Foods restaurant policies (finalized).
// This is the single source of truth: backend services import values from here,
// and Claude reads them through the getRestaurantPolicies tool, so keep them accurate.
//
// Conventions:
// - Money is integer paisa (PKR 1 = 100 paisa), so PKR 1,249.50 is 124950.
// - Times are 24-hour "HH:MM" strings in the restaurant's timezone.

const restaurantPolicies = {
  // General restaurant information
  general: {
    restaurantName: "Hammad Foods",
    city: "Karachi",
    country: "Pakistan",
    // Given to guests whenever they're told to contact the restaurant
    contactPhone: "03353021103",
  },

  // Restaurant timezone. Every time in this file is in this timezone.
  timezone: "Asia/Karachi",

  // Opening days and hours
  openingHours: {
    closedDays: ["Monday"],
    openDays: ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    open: "12:00",
    close: "23:00",
  },

  // Buffet sessions and pricing
  buffet: {
    // A buffet reservation covers the whole fixed session
    reservationCoversEntireSession: true,
    pricesIncludeTax: true,
    sessions: {
      lunch: {
        start: "12:00",
        end: "15:30",
        adultPricePaisa: 249900, // PKR 2,499
        childPricePaisa: 124950, // PKR 1,249.50, for children aged 3 to 11
      },
      dinner: {
        start: "19:00",
        end: "23:00",
        adultPricePaisa: 349900, // PKR 3,499
        childPricePaisa: 174950, // PKR 1,749.50, for children aged 3 to 11
      },
    },
  },

  // À la carte timings and duration
  aLaCarte: {
    start: "12:00",
    end: "23:00",
    reservationDurationMinutes: 120,
    // Reservations can start every 30 minutes
    slotIntervalMinutes: 30,
    hasFixedPerPersonCharge: false,
    requiresAdvancePayment: false,
  },

  // Reservation limits and modification/cancellation policies
  reservations: {
    maxAdvanceDays: 30,
    maxOnlinePartySize: 15,
    gracePeriodMinutes: 15,
    modificationAndCancellationCutoffHours: 3,
    // X is a placeholder for one character of the code
    codeFormat: "RSV-XXXX",
  },

  // Child pricing and age definition
  children: {
    // Guests younger than this age count as children
    childAgeUnder: 12,
    // Any party with children must sit in this table section
    requiredSectionForPartiesWithChildren: "FAMILY",
    buffetPricing: {
      // Children younger than this eat the buffet for free
      freeUnderAge: 3,
      // Children aged 3 to 11 pay this percentage of the adult price
      discountedMinAge: 3,
      discountedMaxAge: 11,
      percentOfAdultPrice: 50,
    },
  },

  // Extras, prices, notice requirements and approval requirements
  extras: {
    paidAtRestaurant: true,
    // A reservation can be confirmed while an extra still awaits Staff approval
    reservationCanBeConfirmedWhileApprovalPending: true,
    numberOfTables: 10,
    items: [
      {
        key: "birthday_cake",
        name: "Birthday cake",
        pricePaisa: 300000, // PKR 3,000
        noticeHours: 24,
        requiresStaffApproval: false,
      },
      {
        key: "candles",
        name: "Candles",
        pricePaisa: 30000, // PKR 300
        noticeHours: 2,
        requiresStaffApproval: false,
      },
      {
        key: "high_chair",
        name: "High chair",
        pricePaisa: 0, // Free
        noticeHours: 2,
        requiresStaffApproval: false,
        subjectToAvailability: true,
      },
      {
        key: "balloons",
        name: "Balloons",
        pricePaisa: 150000, // PKR 1,500
        noticeHours: 24,
        requiresStaffApproval: true,
      },
      {
        key: "birthday_decorations",
        name: "Birthday decorations",
        pricePaisa: 400000, // PKR 4,000
        noticeHours: 48,
        requiresStaffApproval: true,
      },
    ],
    // Guests bringing their own cake
    outsideCake: {
      requiresStaffApproval: true,
      serviceFeePaisa: 50000, // PKR 500
    },
  },

  // Proposal expiry and warning limits
  conversation: {
    // A pending proposal must be accepted within this time
    proposalExpiryMinutes: 5,
    // The conversation is blocked when it reaches this many warnings
    warningLimit: 3,
  },
};

module.exports = restaurantPolicies;
