/** Two study companions based on the user's orange-and-white and golden cats. */
const face = (golden = false): string => `
  <g class="study-cat-ear study-cat-ear-left">
    <path class="study-cat-fur" d="M61 66 58 34q1-5 5-2l25 20Z"/>
    <path class="study-cat-pink" d="m65 54-2-14 15 12Z"/>
  </g>
  <g class="study-cat-ear study-cat-ear-right">
    <path class="study-cat-fur" d="m106 52 25-20q4-3 5 2l-3 32Z"/>
    <path class="study-cat-pink" d="m117 52 13-12-2 16Z"/>
  </g>
  <path class="study-cat-fur" d="M58 80c0-23 15-35 37-35 23 0 38 14 38 35 0 20-16 31-38 31S58 101 58 80Z"/>
  <path class="study-cat-stripe" d="m85 47 3 12q2 4 4 0l1-14Zm13-2 2 14q2 4 4 0l3-11Z"/>
  ${
    golden
      ? '<ellipse class="study-cat-muzzle" cx="95" cy="94" rx="22" ry="13"/>'
      : '<path class="study-cat-white" d="M95 64c-5 13-9 18-19 20-10 3-12 12-6 17 14 14 43 14 54-2 4-7-1-12-10-15-9-3-14-9-19-20Z"/>'
  }

  <path class="study-cat-whiskers" d="m62 83-13-3m13 10-13 2m80-9 13-3m-13 10 13 2"/>
  <ellipse class="study-cat-pink" cx="71" cy="88" rx="7" ry="4"/>
  <ellipse class="study-cat-pink" cx="119" cy="88" rx="7" ry="4"/>
  <g class="study-cat-eyes avatar-eyes">
    <ellipse class="study-cat-eye-rim" cx="80" cy="78" rx="${golden ? 9 : 7}" ry="${golden ? 10 : 7.5}"/>
    <ellipse class="study-cat-eye-rim" cx="111" cy="78" rx="${golden ? 9 : 7}" ry="${golden ? 10 : 7.5}"/>
    <ellipse class="study-cat-iris" cx="80" cy="78" rx="${golden ? 7 : 5}" ry="${golden ? 8 : 5.5}"/>
    <ellipse class="study-cat-iris" cx="111" cy="78" rx="${golden ? 7 : 5}" ry="${golden ? 8 : 5.5}"/>
    <ellipse class="study-cat-ink" cx="80" cy="78" rx="3.4" ry="6"/>
    <ellipse class="study-cat-ink" cx="111" cy="78" rx="3.4" ry="6"/>
    <circle fill="#fffdf6" cx="82" cy="75" r="1.8"/>
    <circle fill="#fffdf6" cx="113" cy="75" r="1.8"/>
  </g>
  <path class="study-cat-nose" d="M91 88q4-3 8 0l-4 5Z"/>
  <path class="study-cat-line" d="M95 93q-4 5-8 0m8 0q4 5 8 0"/>
`;

const companion = (golden = false): string => `
  <g class="study-cat-body">
    <g class="study-cat-tail">
      <path class="study-cat-tail-outline" d="M126 146c29 7 37-8 31-20-4-9-13-7-14-1"/>
      <path class="study-cat-tail-fill" d="M126 146c29 7 37-8 31-20-4-9-13-7-14-1"/>
      <path class="study-cat-tail-stripe" d="m143 145 3 7m8-16 8 1"/>
    </g>
    <path class="study-cat-fur" d="M69 106q-12 17-9 36c3 17 70 17 73 0 3-19-9-31-15-36Z"/>
    <ellipse class="study-cat-chest" cx="96" cy="132" rx="20" ry="19"/>
    <ellipse class="study-cat-fur study-cat-paw" cx="72" cy="154" rx="16" ry="8"/>
    <ellipse class="study-cat-fur study-cat-paw" cx="120" cy="154" rx="16" ry="8"/>
    <g class="study-cat-head">${face(golden)}</g>
    <g class="study-cat-guide-prop">
      <g class="study-cat-asking-paw"><path class="study-cat-fur study-cat-paw" d="M70 121q-15-2-14-14 1-9 9-7 9 3 13 14"/></g>
      <path class="study-cat-fur" d="M120 120q13 1 10 12-3 8-13 2"/>
    </g>
    <g class="study-cat-summary-prop">
      <path class="study-cat-paper" d="m63 126 33 4 34-4-2 30-32 5-31-5Z"/>
      <path class="study-cat-line study-cat-book-spine" d="M96 133v24"/>
      <path class="study-cat-note-line" d="m73 137 14 2m-14 5 14 2m17-7 15-2m-15 9 11-2"/>
      <path class="study-cat-fur study-cat-paw" d="M65 120q-14 0-10 11 3 8 14 2"/>
      <g class="study-cat-writing">
        <path class="study-cat-pencil" d="m116 141 11-27 5 2-11 27-5 4Z"/>
        <path class="study-cat-fur study-cat-paw" d="M124 120q15-3 14 7-1 9-15 7-8-4 1-14Z"/>
      </g>
    </g>
  </g>
`;

/** The golden cat has its own low, tucked-paw pose and reading gestures. */
const goldenCompanion = `<g class="study-cat-body golden-loaf">
  <g class="golden-tail">
    <path class="study-cat-tail-outline" d="M132 145q35 10 33-13-1-13-9-13"/>
    <path class="study-cat-tail-fill" d="M132 145q35 10 33-13-1-13-9-13"/>
    <path class="study-cat-tail-stripe" d="m154 149 4-6m2-11 7-1"/>
  </g>
  <ellipse class="study-cat-fur" cx="108" cy="137" rx="45" ry="25"/>
  <path class="study-cat-stripe" d="m137 121 5 16 5-3-5-10Zm-6 5 3 14 5-2-4-13Z"/>
  <ellipse class="study-cat-chest" cx="82" cy="142" rx="22" ry="16"/>
  <g transform="translate(-10 24)"><g class="study-cat-head">${face(true)}</g></g>
  <g class="study-cat-guide-prop golden-resting-paws">
    <ellipse class="study-cat-fur" cx="72" cy="153" rx="18" ry="8"/>
    <ellipse class="study-cat-fur" cx="97" cy="156" rx="18" ry="7"/>
    <path class="study-cat-line" d="M61 154v3m6-3v4m25-1v3m6-3v3"/>
  </g>
  <g class="study-cat-summary-prop">
    <path class="study-cat-paper" d="m39 150 43-5 43 5 5 23-47-4-46 4Z"/>
    <path class="study-cat-line" d="m82 147 1 20"/>
    <path class="study-cat-note-line" d="m49 156 24-3m-23 9 23-3m19-6 22 3m-22 3 23 3"/>
    <ellipse class="study-cat-fur" cx="113" cy="149" rx="13" ry="7"/>
    <g class="golden-tracing-paw">
      <path class="study-cat-fur" d="M63 137q-11 1-13 13-1 9 8 10 8 1 11-7l4-10"/>
      <path class="study-cat-line" d="m55 151 1 5m5-5v5"/>
    </g>
  </g>
</g>`;

export const MASCOT_AVATAR = `<svg viewBox="0 0 156 100" focusable="false">
  <g class="study-cat-orange" transform="translate(-30 0) scale(.88)"><g class="avatar-head">${face()}</g></g>
  <g class="study-cat-golden" transform="translate(48 3) scale(.88)"><g class="avatar-head">${face(true)}</g></g>
</svg>`;

export const MASCOT_LOADING = `<svg class="study-cat-scene" viewBox="0 0 320 190" focusable="false">
  <ellipse class="study-cat-ground" cx="158" cy="166" rx="115" ry="6"/>
  <g class="study-cat-orange" transform="translate(-2 6)">${companion()}</g>
  <g class="study-cat-golden" transform="translate(139 13) scale(.95)">${goldenCompanion}</g>
  <g class="study-cat-thought" transform="translate(-1 1)">
    <path class="study-cat-bubble" d="M148 20h23q10 0 10 10v15q0 10-10 10h-15l-9 7 2-8q-10-1-10-10V30q0-10 9-10Z"/>
    <path class="study-cat-question" d="M154 32c0-8 13-8 13 0 0 5-7 4-7 9m0 5v1"/>
  </g>
  <g class="study-cat-summary-spark study-cat-line"><path d="M164 86v10m-5-5h10M34 103v6m-3-3h6"/></g>
</svg>`;
