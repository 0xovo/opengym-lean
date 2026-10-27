// The starting profile behind the demo build (see demo.js). Imported dynamically, so it stays
// out of the bundle self-hosters ship.
//
// This fork opens empty on purpose: no fabricated history, no example weigh-ins, no starter
// routines preloaded. A first-time visitor gets exactly what a fresh install gets, a clean
// slate, and anything in the app is data they put there themselves. The state below mirrors
// the store defaults (DEF in store/useStore.js) for every user-data key; the overlay in the
// store (Object.assign(clone(DEF), buildDemoState())) leaves everything else at its default.
export function buildDemoState() {
  return {
    routines: [],
    week: {},
    dayPlan: {},
    dayNotes: {},
    workouts: [],
    bodyweight: [],
    measurements: [],
    customMeasurements: [],
    customEx: [],
    exWeights: {},
    exNotes: {},
    favEx: [],
    equipProfiles: [],
    active: null,
    queue: null,
    rotation: null,
    activeEquipId: null,
    targetW: null,
    effort: null
  }
}
