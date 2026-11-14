/* THE PROGRAM OS — Development roster (SYNTHETIC ONLY)
 * server/fixtures/dev-roster.js
 *
 * The athlete/coach directory the dev-only server (server/dev-server.js)
 * serves the assessment workflow from. Every person here is invented:
 * the two fixture athletes (48-year-old wingback, 12-year-old youth)
 * plus six invented cohort athletes with no recorded sessions, so the
 * dev Assessments view shows every reassessment bucket (never-assessed,
 * due, overdue) on first load.
 *
 * This file is NEVER loaded by production code and NEVER written to a
 * live database. The dev server is localhost-only, memory stores only.
 *
 * Coaches mirror the prototype's cohort coaches (Marcus / Kayla /
 * Jordan). Dev auth users (what the browser sends as X-Dev-User):
 *   dev-director-marcus  director (Marcus — everything)
 *   dev-coach-kayla      coach 'kayla' (YAK cohorts)
 *   dev-coach-jordan     coach 'jordan' (ELL cohorts)
 *   dev-coach-marcus     coach 'marcus' (CLE cohorts + the adult athlete)
 *   dev-parent-youth     parent, guardian of the 12-year-old only
 *   dev-athlete-youth    the 12-year-old athlete themself
 */
'use strict';

const Wingback = require('./synthetic-wingback-48');
const Youth = require('./synthetic-youth-12');

const ATHLETES = [
  {
    ...Wingback.athlete,
    name: 'Synthetic Wingback (48)',
    cohort: 'CLE-B',
    coachIds: ['marcus'],
    guardianUserIds: [],
    authUserId: null,
  },
  {
    ...Youth.athlete,
    name: 'Synthetic Youth (12)',
    cohort: 'YAK-B',
    coachIds: ['kayla'],
    guardianUserIds: ['dev-parent-youth'],
    authUserId: 'dev-athlete-youth',
  },
  { id: 'dev-ath-01', synthetic: true, name: 'Dev Athlete 01', age: 10, cohort: 'YAK-A', coachIds: ['kayla'], guardianUserIds: [] },
  { id: 'dev-ath-02', synthetic: true, name: 'Dev Athlete 02', age: 11, cohort: 'YAK-A', coachIds: ['kayla'], guardianUserIds: [] },
  { id: 'dev-ath-03', synthetic: true, name: 'Dev Athlete 03', age: 13, cohort: 'YAK-C', coachIds: ['kayla'], guardianUserIds: [] },
  { id: 'dev-ath-04', synthetic: true, name: 'Dev Athlete 04', age: 9, cohort: 'ELL-A', coachIds: ['jordan'], guardianUserIds: [] },
  { id: 'dev-ath-05', synthetic: true, name: 'Dev Athlete 05', age: 14, cohort: 'ELL-B', coachIds: ['jordan'], guardianUserIds: [] },
  { id: 'dev-ath-06', synthetic: true, name: 'Dev Athlete 06', age: 8, cohort: 'CLE-A', coachIds: ['marcus'], guardianUserIds: [] },
];

const COACH_AUTH = {
  'dev-coach-kayla': 'kayla',
  'dev-coach-jordan': 'jordan',
  'dev-coach-marcus': 'marcus',
};

/* Dev auth users offered by the UI's "View as" switcher. label is
 * display-only; user is the X-Dev-User header value. */
const DEV_USERS = [
  { role: 'director', user: 'dev-director-marcus', label: 'Director (Marcus)' },
  { role: 'coach', user: 'dev-coach-kayla', label: 'Coach Kayla (YAK)' },
  { role: 'coach', user: 'dev-coach-jordan', label: 'Coach Jordan (ELL)' },
  { role: 'coach', user: 'dev-coach-marcus', label: 'Coach Marcus (CLE)' },
  { role: 'parent', user: 'dev-parent-youth', label: 'Parent of Synthetic Youth (12)' },
  { role: 'athlete', user: 'dev-athlete-youth', athleteId: Youth.athlete.id, label: 'Athlete: Synthetic Youth (12)' },
];

module.exports = { ATHLETES, COACH_AUTH, DEV_USERS, Wingback, Youth };
