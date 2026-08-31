
/**
 * AskJobs Apply with Autofill — content script.
 *
 * Runs only on the ATS domains listed in manifest.json's content_scripts
 * (a small starter allowlist, not <all_urls>). Scans the page for form
 * fields — including ones that render later via JS (SPA/multi-step ATS
 * forms) — and fills them from the user's AskJobs profile/resume data.
 * Never auto-submits; the user always clicks submit themselves.
 */
(function () {
  if (window.__askjobsAutofillInjected) return;
  window.__askjobsAutofillInjected = true;

  // Confirmed real (Ashby's RevenueCat application): a GDPR consent
  // checkbox's real label ("I acknowledge the GDPR Candidate Privacy
  // Notice") sits in the same container as the entire multi-thousand-word
  // privacy notice body text that follows it, and label-resolution walked
  // up to a container that swept up both — producing a "question" that was
  // the whole legal document. That flooded the sidebar with an unreadable
  // wall of text, AND (since the notice happens to use the word
  // "disability" in an unrelated clause) got the field misclassified as a
  // disability question by simple substring matching. A real screening
  // question is never this long — even the longest legitimate one seen so
  // far (a multi-sentence interview-recording consent notice) is well
  // under 500 characters — so anything past this is almost certainly an
  // over-broad label capture, not a real question, and is rejected the
  // same way a too-SHORT label already is everywhere in this file.
  const MAX_QUESTION_LABEL_LENGTH = 800;

  const FIELD_MATCHERS = [
    { key: "firstName", patterns: ["first name", "firstname", "given name"] },
    { key: "lastName", patterns: ["last name", "lastname", "surname", "family name"] },
    { key: "email", patterns: ["email"] },
    {
      key: "phone",
      patterns: ["phone", "mobile", "contact number"],
      // Confirmed real bug: bare "phone" also matched "Country Phone
      // Code" and "Phone Extension" — completely different fields — and
      // filled all three with the raw phone digits. Neither is something
      // we have real data for (no stored calling code, no extension), so
      // excluded rather than guessed.
      excludePatterns: ["phone code", "country code", "extension"],
    },
    // Structured address sub-fields — checked BEFORE the generic "location"
    // fallback below. Confirmed real bug: the old bare "address"/"city"
    // patterns lived under a single "location" key mapped to one flat
    // profile.personalInfo.location string ("Hyderabad"), which got dumped
    // into every address-shaped field on a multi-field form (Address Line
    // 1, Address Line 2, City, State, Postal Code all getting the same
    // value). Now sourced from the dedicated profile.address object
    // instead, one real sub-field per real sub-field.
    { key: "addressStreet", patterns: ["street address", "address line 1", "address line1", "mailing address", "home address"] },
    { key: "addressCity", patterns: ["city"] },
    { key: "addressState", patterns: ["state/province", "state / province", "province", "state"] },
    { key: "addressPostalCode", patterns: ["postal code", "zip code", "zipcode", "postcode"] },
    // Confirmed real bug: with no dedicated "country" category, a combobox
    // asking "Please choose the country in which you are located." fell
    // through to the backend's generic classify-fields AI fallback, which
    // — lacking any better option — mapped it to the "location" key and
    // suggested the candidate's stored CITY ("Hyderabad") as if it were a
    // country. profile.address.country already exists and was simply never
    // wired up to anything.
    {
      key: "addressCountry",
      patterns: ["country"],
      // "Country Phone Code"/"Country Code" belong to the phone dial-code
      // selector, not an address; "Country of Citizenship" is a distinct,
      // more sensitive legal-status question. Neither should get the
      // candidate's address.country value.
      excludePatterns: ["phone code", "country code", "citizenship"],
    },
    { key: "location", patterns: ["location"] },
    { key: "linkedin", patterns: ["linkedin"] },
    { key: "portfolio", patterns: ["portfolio", "website", "personal site"] },
    { key: "currentJobTitle", patterns: ["current title", "job title", "current role"] },
    { key: "dateOfBirth", patterns: ["date of birth", "birth date", "dob"] },
    { key: "skills", patterns: ["skills", "key skills", "skill set"] },
    { key: "coverLetter", patterns: ["cover letter", "covering letter", "motivation letter"] },
    // Deliberately NOT matching a bare "name" substring here — that wrongly
    // matched fields like "Middle Name" or "Nickname", filling them with
    // the user's full name. "full name"/"your name" are specific enough to
    // stay safe while still covering the common single-field-name case.
    { key: "fullName", patterns: ["full name", "your name"] },
  ];

  // Radio-button screening questions — matched at the GROUP level (the
  // overall question text), not per-individual-option, since "Yes"/"No"
  // alone carries no meaning without the question they're answering.
  const RADIO_MATCHERS = [
    {
      key: "atLeast18",
      patterns: ["at least 18", "18 years of age", "18 years old"],
      // Confirmed real (Lever): "If you are under 18 years of age, do you
      // have a work permit if required by applicable state law?" contains
      // the literal substring "18 years of age" but asks a COMPLETELY
      // different, conditional question (work-permit status, only relevant
      // if under 18) — not "are you 18+". Plain substring matching would
      // false-positive here and insert an answer computed for the wrong
      // question. Excluded whenever the question is conditionally framed
      // around being UNDER 18 or mentions a work permit specifically.
      excludePatterns: ["under 18", "work permit"],
    },
    { key: "workAuthorized", patterns: ["authorized to work", "legally authorized", "work authorization", "legally eligible to work"] },
    { key: "visaSponsorshipNeeded", patterns: ["sponsorship", "sponsor your employment", "require sponsorship"] },
    { key: "willingToRelocate", patterns: ["willing to relocate", "relocation"] },
    {
      key: "workedHereBefore",
      patterns: [
        "worked here before",
        "previously employed",
        "prior employee",
        "former employee",
        "worked for this company",
        "worked at this company",
        // Confirmed real (Barclays' Workday form): "Have you previously
        // worked for this organization?" — "organization"/"employer" are
        // just as common a stand-in for "company" as the phrase itself, and
        // the bare "previously worked for/at" pair covers either wording
        // without needing to enumerate every noun a site might use.
        "worked for this organization",
        "worked at this organization",
        "previously worked for",
        "previously worked at",
        // "ever employed by" confirmed real via Genpact's Workday form
        // ("Were you ever employed by Genpact?") — specific enough (3
        // words, "ever" implies self-referential history) to keep
        // unconditional. The bare "employed by" / "employee of" /
        // "worked with" variants that used to sit here were REMOVED —
        // confirmed real false-positive: an Amex compliance question
        // ("...or employee of PricewaterhouseCoopers...") matched
        // "employee of" even though it has nothing to do with the company
        // being applied to. Those bare phrases are too generic to assume
        // they're about "this employer" specifically.
        "ever employed by",
      ],
    },
  ];

  // Shared matcher used everywhere RADIO_MATCHERS is consulted — a single
  // place to apply excludePatterns rather than repeating the same
  // find/some/some logic at every call site.
  function matchRadioQuestion(questionText) {
    return RADIO_MATCHERS.find(
      (m) =>
        m.patterns.some((p) => questionText.includes(p)) &&
        !(m.excludePatterns || []).some((p) => questionText.includes(p))
    );
  }

  // Voluntary demographic self-identification questions (EEO/diversity
  // surveys — confirmed real via Ashby: age range, transgender status,
  // sexual orientation, ethnicity, veteran status). These are explicitly
  // optional and, aside from gender and disability (both handled separately
  // below, since they're actual stored — opt-in, candidate-set — fields,
  // never AI-guessed), not derivable from a resume or profile at all —
  // sensitive enough that guessing, or even sending the question to our own
  // AI classification endpoints, isn't appropriate. Never auto-filled or
  // AI-suggested — just flagged in the sidebar so the candidate knows the
  // question is there.
  const SENSITIVE_SELF_ID_PATTERNS = [
    "sexual orientation",
    "transgender",
    "which ethnicity",
    "ethnicit", // catches "ethnicity"/"ethnicities" regardless of exact phrasing
    "veteran status",
    "protected veteran",
    "diversity survey",
    "voluntary self-identification",
    "voluntary self identification",
    "current age", // Ashby's demographic age-BRACKET question ("Under 30"/"30-39"/...), distinct from the atLeast18 legal-eligibility Yes/No question
    "age range",
  ];

  function isSensitiveSelfIdQuestion(normalizedQuestionText) {
    return SENSITIVE_SELF_ID_PATTERNS.some((p) => normalizedQuestionText.includes(p));
  }

  // Real, candidate-stated EEO answers for the categories above — still only
  // ever a review-before-insert suggestion (see every call site below),
  // never auto-filled, exactly like every other suggestion in this file.
  // "transgender"/"diversity survey"/"age range" have no distinct stored
  // field on CandidateEeoProfile, so they still fall through to a plain
  // "left for you to answer" flag with nothing to suggest — that's a real
  // gap in what's stored, not a category this deliberately withholds.
  function eeoVeteranStatusText() {
    if (eeoProfile?.veteranStatus === "yes") return "Yes";
    if (eeoProfile?.veteranStatus === "no") return "No";
    if (eeoProfile?.veteranStatus === "decline_to_answer") return "Decline to answer";
    return null;
  }

  function eeoHispanicOrLatinoText() {
    if (eeoProfile?.hispanicOrLatino === "yes") return "Hispanic or Latino";
    if (eeoProfile?.hispanicOrLatino === "no") return "Not Hispanic or Latino";
    return null;
  }

  // For free-text fields only, which can hold any combined string —
  // select/radio/checkbox/combobox widgets need a value that can actually
  // match one of their real rendered options, so they use the narrower
  // single-value/multi-value variants below instead.
  function sensitiveSelfIdFreeText(normalizedQuestionText) {
    if (!eeoProfile) return null;
    if (normalizedQuestionText.includes("veteran")) return eeoVeteranStatusText();
    if (normalizedQuestionText.includes("ethnicit") || normalizedQuestionText.includes("hispanic") || normalizedQuestionText.includes("racial")) {
      return [eeoProfile.race, eeoHispanicOrLatinoText()].filter(Boolean).join(", ") || null;
    }
    if (normalizedQuestionText.includes("sexual orientation")) {
      return Array.isArray(eeoProfile.sexualOrientation) && eeoProfile.sexualOrientation.length
        ? eeoProfile.sexualOrientation.join(", ")
        : null;
    }
    return null;
  }

  // For select/radio/single-pick combobox widgets — only returns a value
  // when it's unambiguous as a SINGLE choice (a combined "race, ethnicity"
  // string or a multi-item sexual-orientation list can't correctly become
  // one clicked option, so those cases return null here rather than
  // insert something misleadingly partial).
  function sensitiveSelfIdSingleValue(normalizedQuestionText) {
    if (!eeoProfile) return null;
    if (normalizedQuestionText.includes("veteran")) return eeoVeteranStatusText();
    if (normalizedQuestionText.includes("ethnicit") || normalizedQuestionText.includes("hispanic") || normalizedQuestionText.includes("racial")) {
      return eeoProfile.race || null;
    }
    if (normalizedQuestionText.includes("sexual orientation") && eeoProfile.sexualOrientation?.length === 1) {
      return eeoProfile.sexualOrientation[0];
    }
    return null;
  }

  // For genuine "mark all that apply" checkbox GROUPS — the one widget
  // shape that can correctly represent more than one selected value at
  // once, so sexual orientation's full array and a combined race+ethnicity
  // pair both get a real shot at matching multiple real checkboxes.
  function sensitiveSelfIdCheckboxTargets(normalizedQuestionText, boxes) {
    if (!eeoProfile) return null;

    let wantedValues;
    if (normalizedQuestionText.includes("sexual orientation")) {
      wantedValues = Array.isArray(eeoProfile.sexualOrientation) ? eeoProfile.sexualOrientation : [];
    } else if (normalizedQuestionText.includes("veteran")) {
      const v = eeoVeteranStatusText();
      wantedValues = v ? [v] : [];
    } else if (normalizedQuestionText.includes("ethnicit") || normalizedQuestionText.includes("hispanic") || normalizedQuestionText.includes("racial")) {
      wantedValues = [eeoProfile.race, eeoHispanicOrLatinoText()].filter(Boolean);
    } else {
      return null;
    }
    if (wantedValues.length === 0) return null;

    const targets = [];
    for (const wanted of wantedValues) {
      const normWanted = normalize(wanted);
      const box = boxes.find((b) => {
        const optionText = normalize(labelForField(b) || b.value || "");
        return optionText && (optionText.includes(normWanted) || normWanted.includes(optionText));
      });
      if (box && !targets.includes(box)) targets.push(box);
    }
    if (targets.length === 0) return null;

    const displayText = targets.map((b) => (labelForField(b) || b.value || "").trim()).join(", ");
    return { targets, displayText };
  }

  function isGenderIdentityQuestion(normalizedQuestionText) {
    // Confirmed real miss: "What gender do you identify with?" (Remote's
    // Greenhouse form) contains neither a literal "gender identity" nor
    // "what is your gender" phrase — "gender" and "identify" appear in the
    // sentence but not adjacent — so a fixed-phrase check silently passed
    // this question through unrecognized. This was first fixed by requiring
    // "gender" AND "identify"/"identity" together, but that missed the far
    // MORE common real-world case: a form that just labels the field plain
    // "Gender" (BambooHR, confirmed real) — no "identity" phrasing at all —
    // which also went unrecognized, with nowhere else to send it (there's
    // no generic "gender" category in the AI classifier fallback either).
    //
    // Confirmed real regression from the "identify" broadening, and the
    // reason this isn't a bare .includes("gender") check: "Do you identify
    // as part of the Lesbian, Bisexual, Gay, Transgender, Queer, Intersex,
    // and Asexual (LGBTQIA+) community?" got misrouted here too and
    // answered with the stored gender ("Male") — a completely different,
    // sensitive question that isSensitiveSelfIdQuestion already correctly
    // blocks via its "transgender" pattern, EXCEPT a plain substring check
    // for "gender" also matches the "gender" INSIDE "transgender" and steals
    // the question away before the sensitive-list check (which runs after
    // this one) ever gets a chance to catch it. matchesWholeWord requires
    // "gender" as its own word, which "transgender" does not contain — so
    // this is now simply "gender" as a standalone word, nothing more
    // specific required, which correctly covers "Gender", "gender
    // identity", "what is your gender", and "what gender do you identify
    // with" all at once, without reopening the transgender collision.
    return matchesWholeWord(normalizedQuestionText, "gender");
  }

  // Bare "disability" (not "person with disability") — confirmed real miss:
  // "Are you a person with a disability?" normalizes to "...person with a
  // disability", which does NOT contain the literal substring "person with
  // disability" (missing article "a" breaks it). A single broad
  // "disability" pattern catches every real phrasing variant instead of
  // chasing each one.
  function isDisabilityQuestion(normalizedQuestionText) {
    return normalizedQuestionText.includes("disability");
  }

  // Confirmed real (BambooHR): a country combobox labeled just "Country*"
  // (8 characters) never got a chance to be recognized at all — it fell to
  // the generic "queue for AI" branch in scanAndFillGenericComboboxes,
  // which requires a 10+ character label to guard against scooping up
  // noise/cosmetic buttons as if they were real questions. That guard makes
  // sense for the AI fallback (an unrecognized short label is genuinely
  // ambiguous), but a country field doesn't need AI at all — profile.
  // address.country already exists and is a direct, deterministic answer
  // regardless of how short the field's own label happens to be. Same
  // exclude list as the addressCountry FIELD_MATCHER (a plain-field
  // equivalent of this same category): "country code"/"phone code" belong
  // to a dial-code selector, not an address; "citizenship" is a distinct,
  // more sensitive legal-status question.
  function isCountryQuestion(normalizedQuestionText) {
    return (
      matchesWholeWord(normalizedQuestionText, "country") &&
      !normalizedQuestionText.includes("phone code") &&
      !normalizedQuestionText.includes("country code") &&
      !normalizedQuestionText.includes("citizenship")
    );
  }

  // Confirmed real across MULTIPLE, wildly different ATS platforms
  // (BambooHR's <fieldset><legend>Phone</legend> wrapping a Country
  // selector + number input as siblings; Recruitee's div wrapping a
  // flag/country dropdown + number input the same way) — phone widgets
  // very commonly bundle a SEPARATE country/dial-code selector immediately
  // next to the number field, using completely different markup and class
  // names from site to site. Rather than hard-code each site's specific
  // structure (which only ever covers the one site just inspected — not a
  // scalable way to handle this across the 200+ ATS platforms real job
  // postings span), this looks for that STRUCTURAL pattern generically:
  // any select/combobox sharing a close-by container with the phone field
  // itself, checked tightest-scope-first so an unrelated widget elsewhere
  // in a larger surrounding section isn't picked up by mistake.
  function findNearbyCountrySelector(phoneField) {
    const candidates = [
      phoneField.parentElement,
      phoneField.closest("fieldset"),
      phoneField.parentElement?.parentElement,
    ].filter(Boolean);
    for (const container of candidates) {
      const match = deepQueryAll(container, "select, [role='combobox'], button[aria-haspopup='listbox']").find(
        (el) => el !== phoneField
      );
      if (match) return match;
    }
    return null;
  }

  // Sets a phone widget's country/dial-code selector to the candidate's
  // stored address country, if one is found nearby (see
  // findNearbyCountrySelector) and one is actually on file. Handles both
  // shapes generically, reusing the same infrastructure already built for
  // every other native-select/custom-combobox field in this file, rather
  // than anything specific to one site's widget.
  async function fillNearbyCountrySelector(phoneField) {
    const country = profile?.address?.country;
    if (!country) {
      console.log("[AskJobs] phone country selector skipped — no country set in your profile");
      return;
    }
    const selector = findNearbyCountrySelector(phoneField);
    if (!selector) {
      console.log("[AskJobs] phone country selector skipped — no nearby selector found");
      return;
    }
    const signature = fieldSignature(selector);
    if (attemptedSignatures.has(signature)) return;
    attemptedSignatures.add(signature);

    if (selector.tagName === "SELECT") {
      const option = Array.from(selector.options).find((o) => normalize(o.textContent).includes(normalize(country)));
      if (option) {
        selector.value = option.value;
        selector.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        recordResult("filled", "Phone country code", `${country} (from your profile)`);
      } else {
        recordResult("skipped", "Phone country code", "Couldn't find a matching option");
      }
      return;
    }

    const filled = await fillCustomCombobox(selector, country, "Phone country code");
    recordResult(filled ? "filled" : "skipped", "Phone country code", filled ? `${country} (from your profile)` : "Couldn't find a matching option");
  }

  // Gender and disability status ARE actual stored, opt-in fields (unlike
  // the rest of the sensitive list above) — the candidate explicitly chose
  // to set them (in their AskJobs profile for gender, in Settings ->
  // Screening Questions for disability status), so suggesting them back
  // isn't a guess, it's their own stated answer. Still never auto-inserted:
  // rendered as a review-before-insert card like every other AI/stored-data
  // suggestion in this file, since the exact wording a given ATS offers
  // ("Man"/"Woman" vs "Male"/"Female") may not match verbatim. Left unset by
  // default — a candidate who never sets these still gets the safe,
  // leave-it-for-me-to-answer treatment.
  const GENDER_SYNONYM_GROUPS = [
    { synonyms: ["male", "man", "cisgender man", "cis man"] },
    { synonyms: ["female", "woman", "cisgender woman", "cis woman"] },
    { synonyms: ["non binary", "nonbinary", "genderqueer"] },
  ];

  function bestGenderOptionText(optionTexts) {
    const stored = normalize(profile?.gender || "");
    if (!stored) return null;
    const exact = optionTexts.find((t) => normalize(t) === stored);
    if (exact) return exact;
    const group = GENDER_SYNONYM_GROUPS.find((g) => g.synonyms.includes(stored));
    if (!group) return null;
    return optionTexts.find((t) => group.synonyms.includes(normalize(t))) || null;
  }

  const DISABILITY_SYNONYM_GROUPS = [
    { synonyms: ["yes", "i have a disability", "i identify as having a disability"] },
    { synonyms: ["no", "i do not have a disability", "i don't have a disability"] },
    { synonyms: ["prefer not to say", "i don't wish to answer", "decline to answer", "prefer not to answer", "i do not wish to answer"] },
  ];

  function bestDisabilityOptionText(optionTexts) {
    const stored = normalize(jobPreferences?.disabilityStatus || "");
    if (!stored) return null;
    const exact = optionTexts.find((t) => normalize(t) === stored);
    if (exact) return exact;
    const group = DISABILITY_SYNONYM_GROUPS.find((g) => g.synonyms.includes(stored));
    if (!group) return null;
    return optionTexts.find((t) => group.synonyms.includes(normalize(t))) || null;
  }

  let profile = null;
  // Our Candidate model has no equivalent of OG's per-user jobPreferences
  // (salary/shift/availability/disability status) — always null here, which
  // every reader already treats as "nothing to suggest, leave for the
  // consultant to answer" via optional chaining, same as an OG candidate who
  // never set these.
  let jobPreferences = null;
  // Raw CandidateEeoProfile doc, kept separately from jobPreferences —
  // sensitiveSelfIdFreeText/SingleValue/CheckboxTargets below read this
  // directly to suggest (never auto-fill) real answers for the sensitive
  // self-ID categories isSensitiveSelfIdQuestion otherwise blocks outright.
  let eeoProfile = null;
  let resumeFileUrl = null;
  // True when resumeFileUrl came from the fallback below rather than the
  // job-specific customized resume — lets the sidebar say so, instead of
  // silently attaching a generic resume while claiming success as if it
  // were the tailored one.
  let resumeIsFallbackPrimary = false;
  let resumeSkills = [];
  // Pre-generated at optimization time (ResumeVersion.coverLetter) — fetched
  // alongside the resume file/skills in getResumeFileUrl(), not generated
  // on demand like OG's version.
  let resumeCoverLetter = null;
  let pendingHandoff = null;
  let sidebarShadow = null;
  let sidebarHost = null;
  // Remote-suggestion bridge state (see sendRemoteSuggestion/showSuggestionCard
  // and the message listener near createSuggestionItem). Non-top frames use
  // pendingRemoteInserts to hold onto the REAL insert callback (a closure
  // over a live DOM element only this frame can reference) while the top
  // frame displays the card; the top frame uses remoteSuggestionSources to
  // remember which frame's window a given suggestion came from, so an
  // Insert click can be relayed back to the right place.
  let remoteSuggestionIdCounter = 0;
  const pendingRemoteInserts = new Map();
  const remoteSuggestionSources = new Map();
  let filledCount = 0;
  let skippedCount = 0;
  // True once fillField has encountered a real <input type="file"> at
  // least once this scan — used to detect ATS widgets (confirmed real on
  // SAP SuccessFactors) that render a resume-upload UI entirely out of
  // <div>/<span> elements, creating the actual file input only after a
  // click (often opening the native OS picker at that point, which no
  // script can drive) — meaning our scan never sees one to even attempt.
  let resumeFileInputFound = false;
  let resumeUploadFallbackShown = false;
  // Human-readable trace of every fill attempt, shown directly in the
  // sidebar — not just a bare count — since digging through the DevTools
  // console to figure out what happened was real, reported friction.
  const fieldResults = [];
  const seenFields = new WeakSet();
  // Tracks logical fields (by a stable signature, not DOM node identity) that
  // we've already attempted to fill once. SPA forms like Workday's often
  // recreate the same field as a brand-new DOM node on re-render, which
  // would otherwise look "new" and empty to us and get refilled — silently
  // overwriting anything the user just deliberately cleared. Once attempted,
  // a field is never auto-filled again, full stop.
  const attemptedSignatures = new Set();

  // Fields/radio-groups the deterministic matchers didn't recognize, queued
  // for a single batched AI classification call after each fill pass (never
  // per-field — see runClassificationPass). Signature sets prevent the same
  // still-unresolved field from being re-queued on every re-scan.
  let pendingClassificationItems = [];
  const queuedFieldSignatures = new Set();
  const queuedRadioGroupNames = new Set();

  function fieldSignature(field) {
    return [
      field.tagName,
      field.name || "",
      field.id || "",
      field.getAttribute("placeholder") || "",
      field.getAttribute("aria-label") || "",
    ].join("|");
  }

  function sendMessage(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
  }

  // Shadow-DOM-piercing query — confirmed real (Darwinbox): its form
  // fields aren't plain page elements at all. <dbx-textinput>/<dbx-dropdown>
  // are custom elements whose actual <input>/options render inside an open
  // shadow root (<template shadowrootmode="open">), which a normal
  // document.querySelectorAll simply cannot see — every scan came back
  // with zero fields, not because they were unrecognized, but because they
  // were architecturally invisible. This recursively searches a root AND
  // descends into every shadow root found anywhere under it, so it behaves
  // exactly like a normal querySelectorAll on any site that doesn't use
  // shadow DOM at all (the vast majority), while also reaching in on the
  // ones that do.
  function deepQueryAll(root, selector) {
    const scope = root || document;
    const results = Array.from(scope.querySelectorAll(selector));
    const all = scope.querySelectorAll("*");
    for (const el of all) {
      if (el.shadowRoot) {
        results.push(...deepQueryAll(el.shadowRoot, selector));
      }
    }
    return results;
  }

  // The chain of elements from `el` outward through each shadow boundary it
  // sits inside, ending with the outermost shadow HOST (a real light-DOM
  // element) — used because .closest()/document.querySelector cannot cross
  // OUT of a shadow root: a field's actual <label> often lives in the
  // light DOM as a sibling of the shadow-hosting custom element itself
  // (confirmed real: Darwinbox's <label>Personal mobile no</label> sits
  // next to <dbx-textinput>, not inside its shadow root), so label lookup
  // needs to retry from each level of this chain, not just the field.
  function shadowHostChain(el) {
    const chain = [el];
    let node = el;
    while (node) {
      const root = node.getRootNode();
      if (root instanceof ShadowRoot) {
        chain.push(root.host);
        node = root.host;
      } else {
        break;
      }
    }
    return chain;
  }

  function normalize(text) {
    return (text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  // Like `el.textContent`, but excludes non-visible text nodes (SVG <title>
  // is the common offender — flag icons pair an accessibility <title> with a
  // visible label span, and plain .textContent concatenates both with no
  // separator, e.g. "United States" + "United States" -> "United
  // StatesUnited States". That doubled text was wrongly read as this
  // combobox's "current answer," making an untouched widget look
  // already-filled).
  function visibleText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("title, style, script").forEach((node) => node.remove());
    return clone.textContent || "";
  }

  function labelForOne(field) {
    if (field.id) {
      const byFor = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
      if (byFor?.textContent) return byFor.textContent;
    }
    const closestLabel = field.closest("label");
    if (closestLabel?.textContent) return closestLabel.textContent;
    // Standard accessible-forms pattern for grouped Yes/No questions
    // (confirmed via real HTML: Workday's screening questions wrap each
    // button in a <fieldset> whose <legend> holds the actual question text
    // — "Are you at least 18 years of age?" — with no <label for> and no
    // <label> ancestor at all. Without this, the only text available was
    // the button's own generic aria-label ("Select One Required"), which
    // carries no question content to match against.
    const legend = field.closest("fieldset")?.querySelector("legend");
    if (legend?.textContent) return legend.textContent;
    // Bootstrap-style wrapper convention (confirmed real: Darwinbox's
    // ".form-group" divs) — a light-DOM sibling <label> for a
    // shadow-hosting custom element that isn't referenced by `for=` at
    // all, just positioned before it inside a shared container.
    const group = field.closest(".form-group, [class*='form-group']");
    const groupLabel = group?.querySelector("label");
    if (groupLabel?.textContent) return groupLabel.textContent;
    // Plain-text sibling immediately before the field, with no <label>
    // element, no `for`, and no fieldset/legend at all — confirmed real on
    // Breezy: <span class="date-label">Start date</span><input .../>. Only
    // trusted when it's short plain text, not another field or a stray
    // block of unrelated copy, since sibling proximity alone is a weaker
    // signal than a real label association.
    const prevSibling = field.previousElementSibling;
    const prevText = prevSibling && !prevSibling.matches("input, select, textarea, button") ? prevSibling.textContent?.trim() : "";
    if (prevText && prevText.length < 40) return prevText;
    return "";
  }

  // Tries label resolution at the field itself, then at each successive
  // shadow host outward — the first strategy that finds real light-DOM
  // text (not nested inside another shadow root) wins. No-op extra cost
  // for the common case (no shadow DOM at all): the chain is just
  // [field], identical to the old single-element behavior.
  function labelForField(field) {
    for (const el of shadowHostChain(field)) {
      const label = labelForOne(el);
      if (label?.trim()) return label;
    }
    return "";
  }

  function classify(field) {
    const haystack = normalize(
      [
        field.name,
        field.id,
        field.getAttribute("placeholder"),
        field.getAttribute("aria-label"),
        labelForField(field),
      ].join(" ")
    );

    for (const matcher of FIELD_MATCHERS) {
      if (
        // Confirmed real, serious bug: plain .includes() matched addressCity's
        // "city" pattern INSIDE "ethnicity" (e-t-h-n-i-CITY) and silently
        // filled a "Are you Hispanic/Latino?" ethnicity self-ID question with
        // the candidate's stored city — bypassing the sensitive-question
        // guard entirely, since that only runs in the fallback path reached
        // when classify() returns null, not when it wrongly returns a match.
        // matchesWholeWord requires the pattern to stand as its own word (or
        // phrase, for multi-word patterns like "first name" — a phrase
        // boundary works the same way), so a short pattern can no longer
        // silently match as a fragment of an unrelated, longer word.
        matcher.patterns.some((p) => matchesWholeWord(haystack, p)) &&
        !(matcher.excludePatterns || []).some((p) => matchesWholeWord(haystack, p))
      ) {
        return matcher.key;
      }
    }
    return null;
  }

  // `profile` here is a Candidate doc straight from GET /candidates/:id (flat
  // fields — firstName/lastName/email/phone/address/linkedinUrl/githubUrl/
  // portfolioUrl/currentJobTitle/dob), not OG's nested personalInfo/address
  // object. Candidate.address is a single free-text string, not a
  // {street,city,state,postalCode,country} object, so the structured
  // sub-fields have nothing to return — same as an OG candidate who never
  // filled those in, not a special case. Inventing a parser to split one
  // address string into sub-fields would be exactly the kind of guessing
  // this file deliberately avoids everywhere else; only the generic
  // single-field "location" category gets a value.
  function valueForKey(key) {
    if (!profile) return null;

    switch (key) {
      case "firstName":
        return profile.firstName || null;
      case "lastName":
        return profile.lastName || null;
      case "fullName":
        return [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
      case "email":
        return profile.email || null;
      case "phone":
        return profile.phone || null;
      case "location":
        return profile.address || null;
      case "addressStreet":
      case "addressCity":
      case "addressState":
      case "addressPostalCode":
      case "addressCountry":
        return null;
      case "linkedin":
        return profile.linkedinUrl || null;
      case "portfolio":
        return profile.portfolioUrl || profile.githubUrl || null;
      case "currentJobTitle":
        return profile.currentJobTitle || null;
      case "dateOfBirth":
        return profile.dob || null;
      default:
        return null;
    }
  }

  // Resume skills come categorized ({technical: [], soft: [], custom:
  // [{category, skills: []}]}) — flatten into one plain string array. Kept
  // client-side since the extension can't import the backend's
  // skillsHelper.js utility directly.
  function flattenSkills(skills) {
    if (!skills) return [];
    const flat = [
      ...(skills.technical || []),
      ...(skills.soft || []),
      ...((skills.custom || []).flatMap((c) => c.skills || [])),
    ];
    return flat.filter(Boolean);
  }

  // Date fields vary in expected format across sites (and even within one
  // site, native <input type="date"> vs. a masked text field). Formats the
  // ISO-ish value from the profile to match whichever this specific field
  // expects, rather than assuming one format works everywhere.
  function formatDateForField(field, isoLikeValue) {
    const date = new Date(isoLikeValue);
    if (Number.isNaN(date.getTime())) return null;

    const yyyy = String(date.getFullYear()).padStart(4, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");

    // Native date inputs require exactly YYYY-MM-DD regardless of the
    // browser's/locale's display format.
    if (field.type === "date") return `${yyyy}-${mm}-${dd}`;

    const hint = normalize(field.getAttribute("placeholder") || "");
    // Confirmed real, two bugs found while verifying this actually handles
    // all three real-world orderings (month-first, day-first, year-first):
    // 1. The year-first branch hardcoded a "-" separator regardless of what
    //    the field's own placeholder actually uses — a "yyyy/mm/dd" hint
    //    (slashes) would still get hyphens back. Detect the real separator
    //    instead of assuming one.
    // 2. The "day before month" check ran BEFORE the "year first" check, so
    //    a (rare but real) "yyyy-dd-mm" placeholder would match the
    //    day-first branch first and produce a wrong ordering entirely.
    //    Checking "is year first" up front, and only then whether day comes
    //    before month WITHIN that, fixes the priority.
    const separator = hint.match(/[/\-.]/)?.[0] || "/";
    const ddIndex = hint.indexOf("dd");
    const mmIndex = hint.indexOf("mm");
    const yyyyIndex = hint.indexOf("yyyy");

    if (yyyyIndex !== -1 && mmIndex !== -1 && yyyyIndex < mmIndex) {
      return ddIndex !== -1 && ddIndex < mmIndex
        ? `${yyyy}${separator}${dd}${separator}${mm}` // yyyy-dd-mm (rare)
        : `${yyyy}${separator}${mm}${separator}${dd}`; // yyyy-mm-dd (common)
    }
    if (ddIndex !== -1 && mmIndex !== -1 && ddIndex < mmIndex) {
      return `${dd}${separator}${mm}${separator}${yyyy}`;
    }
    // Default: MM/DD/YYYY — the most common format on US-facing ATS forms.
    return `${mm}${separator}${dd}${separator}${yyyy}`;
  }

  // Confirmed real (CATS One): a "Date Available" field showing an
  // mm/dd/yyyy-masked placeholder got queued for free-text AI answering
  // like any other unrecognized field, and the AI reasonably answered
  // "Immediately" — a sensible phrase for a HUMAN reading the question, but
  // not a valid value for a field that expects an actual calendar date.
  // Reuses formatDateForField's own detection (native type="date", or a
  // dd/mm/yyyy-shaped placeholder) so a date-shaped field is recognized the
  // same way whether we're about to WRITE a formatted date into it or, as
  // here, deciding it should never receive prose from the free-text AI
  // pass at all — there's no reliable way to turn "Immediately" into a
  // specific date without guessing, and guessing a start date is exactly
  // the kind of insert-a-value-we-don't-actually-have this file avoids
  // everywhere else.
  function isDateShapedField(field) {
    if (field.type === "date") return true;
    const hint = normalize(field.getAttribute("placeholder") || "");
    return /\bmm\b.*\byyyy\b|\byyyy\b.*\bmm\b|\bdd\b.*\byyyy\b/.test(hint);
  }

  // Narrower than isDateShapedField — specifically a "when can you start"
  // question, not any date field in general (an "Anticipated Graduation
  // Date" or similar is also date-shaped but has nothing to do with today).
  // Scoped this tightly on purpose: "today" is only a defensible default
  // for THIS specific question, not a general stand-in for dates we don't
  // actually know.
  function isStartDateQuestion(normalizedQuestionText) {
    return (
      normalizedQuestionText.includes("date available") ||
      normalizedQuestionText.includes("available to start") ||
      normalizedQuestionText.includes("start date") ||
      normalizedQuestionText.includes("availability date") ||
      (normalizedQuestionText.includes("when") && normalizedQuestionText.includes("start"))
    );
  }

  // Confirmed real (CATS One): a native <input type="date"> renders its own
  // "mm/dd/yyyy" hint text in the browser itself (Chrome, US locale) —
  // visually identical to a masked/segmented TEXT field, but a completely
  // different input model underneath. A masked text field needs typing
  // simulated character-by-character so each keystroke hits its own JS mask
  // handler; a native date input has its own segment-by-segment
  // (month/day/year) keyboard interaction and doesn't accept raw characters
  // like "-" at all that way — typing an ISO value into one character by
  // character silently did nothing, leaving the field empty while the
  // sidebar wrongly reported success. A native date input just needs its
  // value set directly, the same as any other native form control.
  function fillDateField(field, formattedValue) {
    if (field.type === "date") {
      setNativeValue(field, formattedValue);
    } else {
      typeCharacterByCharacter(field, formattedValue);
    }
  }

  // Sets the value via the native property setter and dispatches real
  // focus/input/change/keydown/blur events — mimics an actual user
  // interaction (click in, type, click away) rather than a silent value
  // swap. The focus/blur pair matters as much as input/change: many
  // React-based form libraries (Workday included) only run real field
  // validation on blur, so a fill that never blurs can leave the field
  // showing the right value while the form's internal state still treats
  // it as invalid/untouched — which silently blocks submission with no
  // visible error (confirmed on Workday's Create Account form).
  function setNativeValue(field, value) {
    const proto = Object.getPrototypeOf(field);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");

    field.focus();
    field.dispatchEvent(new Event("focus", { bubbles: true, composed: true }));
    descriptor.set.call(field, value);

    field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true }));
    field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true }));

    field.blur();
    field.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
    field.dispatchEvent(new Event("focusout", { bubbles: true, composed: true }));
  }

  // Types a string into a field character-by-character, WITHOUT wrapping it
  // in focus/blur — callers that need to type multiple separate strings into
  // the same field in one sitting (e.g. tag-input skills, one skill per
  // Enter) use this directly so the field doesn't lose focus between each.
  // `clearFirst` resets the field's own value before typing (not needed
  // between skills in a tag input, where each committed chip empties it).
  function typeStringInto(field, value, { clearFirst = true } = {}) {
    const proto = Object.getPrototypeOf(field);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");

    if (clearFirst) {
      descriptor.set.call(field, "");
      field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }

    for (const char of value) {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      const current = field.value || "";
      descriptor.set.call(field, current + char);
      field.dispatchEvent(
        typeof InputEvent === "function"
          ? new InputEvent("input", { data: char, inputType: "insertText", bubbles: true })
          : new Event("input", { bubbles: true, composed: true })
      );
      field.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
    }
  }

  function dispatchEnterKey(field) {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    field.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  }

  // Masked/segmented inputs (date-of-birth fields built from separate
  // MM/DD/YYYY segments that just look like one box) maintain their own
  // internal state per keystroke — they don't read the full `.value` you
  // hand them, only individual characters as they arrive. Setting the whole
  // string at once (like setNativeValue does) bypasses that entirely and
  // produces garbage (confirmed: got "10/10/0010" for a real DOB). This
  // simulates actual character-by-character typing instead.
  function typeCharacterByCharacter(field, value) {
    field.focus();
    field.dispatchEvent(new Event("focus", { bubbles: true, composed: true }));

    typeStringInto(field, value);

    field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    field.blur();
    field.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
    field.dispatchEvent(new Event("focusout", { bubbles: true, composed: true }));
  }

  // Looks up the resume's file URL fresh, on-demand — not pre-fetched once
  // at page load and cached for however long it takes to reach the actual
  // upload step. Confirmed real reliability issue (OG): a multi-step ATS
  // form can take several pages/minutes to reach the resume field, and
  // fetching the URL only once at init() time meant attaching it later
  // depended on that value still being good far downstream. Fetching right
  // when the field is actually found means every attempt gets a current
  // lookup, not a stale one. Still cached after a successful fetch so the
  // sidebar's manual-download-link and any later attempt on the same page
  // don't redo the same network round trip.
  // Falls back to the candidate's saved master resume (GET
  // /candidates/:candidateId/master-resume) — same shape as OG's "no
  // job-specific resume" fallback, just sourced from our own MasterResume
  // model instead of a resumes-metadata list. Our endpoints return the plain
  // object directly (no OG-style {data: {data: {...}}} envelope).
  async function getMasterResumeFallback(candidateId) {
    const result = await sendMessage({ type: "API_FETCH", path: `/api/v1/candidates/${candidateId}/master-resume` });
    console.log("[AskJobs] master resume fallback fetch result:", result);
    if (!result?.ok) return { fileUrl: null, skills: [] };
    return {
      fileUrl: result.data?.downloadUrl || null,
      skills: flattenSkills(result.data?.resume?.parsedData?.skills),
    };
  }

  async function getResumeFileUrl() {
    if (resumeFileUrl) return resumeFileUrl;

    if (pendingHandoff?.resumeVersionId) {
      const resumeResult = await sendMessage({
        type: "API_FETCH",
        path: `/api/v1/resume-versions/${pendingHandoff.resumeVersionId}`,
      });
      console.log("[AskJobs] on-demand resume version fetch result:", resumeResult);
      if (resumeResult?.ok) {
        resumeFileUrl = resumeResult.data?.downloadUrl || null;
        resumeSkills = flattenSkills(resumeResult.data?.version?.structuredContent?.skills);
        resumeCoverLetter = resumeResult.data?.version?.coverLetter || null;
      }
    }

    if (!resumeFileUrl && pendingHandoff?.candidateId) {
      const fallback = await getMasterResumeFallback(pendingHandoff.candidateId);
      resumeFileUrl = fallback.fileUrl;
      if (resumeFileUrl) {
        resumeIsFallbackPrimary = true;
        if (!resumeSkills.length) resumeSkills = fallback.skills;
        console.log("[AskJobs] no job-specific resume version available — using master resume as fallback:", resumeFileUrl);
      }
    }

    return resumeFileUrl;
  }

  // Best-effort auto-attach via a simulated drop. Browsers block scripts
  // from assigning `.files` directly, so we fake a drop event instead. Some
  // sites' file inputs reject this — that's the caller's cue to fall back
  // to a manual "download and attach" prompt.
  async function attachResumeFile(input) {
    const fileUrl = await getResumeFileUrl();
    if (!fileUrl) return false;
    try {
      // Fetching the file directly here would run in this page's origin
      // (e.g. barclays.wd3.myworkdayjobs.com) and get blocked by Firebase
      // Storage's CORS policy, which doesn't allow arbitrary third-party
      // origins. The background service worker fetches it instead, where
      // declared host_permissions bypass CORS, and hands it back as a data
      // URL (safe to pass through chrome.runtime.sendMessage).
      const fetchResult = await sendMessage({ type: "FETCH_FILE_AS_DATA_URL", url: fileUrl });
      if (!fetchResult?.ok) {
        console.warn("AskJobs Autofill: resume fetch via background failed", fetchResult);
        return false;
      }

      const blob = await (await fetch(fetchResult.dataUrl)).blob();
      const file = new File([blob], "resume.pdf", { type: "application/pdf" });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return input.files.length > 0;
    } catch (error) {
      console.warn("AskJobs Autofill: resume auto-attach failed", error);
      return false;
    }
  }

  // Some ATS platforms (confirmed real: SAP SuccessFactors) build their
  // resume-upload UI entirely out of <div>/<span> elements with no
  // <input type="file"> in the DOM at all until a click creates one —
  // often followed immediately by the native OS file picker, which no
  // script (ours included) can drive; that's a real browser security
  // boundary, not something to work around. Without this check, a page
  // like that produces total silence in the sidebar — no "filled," no
  // "skipped," nothing — which reads as the extension having missed the
  // field rather than the field being genuinely out of reach. Runs once:
  // if the whole scan never touched a real file input anywhere, but the
  // page has a short "Resume"/"CV"-labeled element (the field's own
  // label, not prose that happens to mention the word), say so plainly and
  // point at the manual-download fallback already built for this exact
  // "couldn't auto-attach" case.
  async function flagUnreachableResumeUploadIfNeeded() {
    if (resumeFileInputFound || resumeUploadFallbackShown) return;
    const candidates = deepQueryAll(document, "label, h1, h2, h3, h4, h5, h6, legend");
    const hasResumeLabel = candidates.some((el) => {
      const text = normalize(el.textContent || "");
      return text.length > 0 && text.length < 40 && (matchesWholeWord(text, "resume") || matchesWholeWord(text, "cv"));
    });
    if (!hasResumeLabel) return;
    resumeUploadFallbackShown = true;
    // showManualResumePrompt no-ops until resumeFileUrl is actually
    // populated — every other caller reaches it via attachResumeFile
    // (which fetches it first); this path never calls that at all since
    // there's no file input to attach to, so it has to fetch explicitly.
    await getResumeFileUrl();
    recordResult("skipped", "Resume/CV", "Couldn't find an upload field to auto-attach — use the download link below");
    showManualResumePrompt();
  }

  // Looks for a word/character limit stated near the field (common
  // phrasing: "Cover Letter (max 200 words)"), preferring that exact
  // figure over inferring one from a raw maxlength attribute — a stated
  // word count is precise, while maxlength is a character budget that has
  // to be estimated into words. Falls back to maxlength only when nothing
  // nearby states a limit in words. Returns null when no limit is found
  // anywhere, meaning the field is genuinely unconstrained.
  function detectWordLimit(field) {
    const nearbyText = normalize(
      [labelForField(field), field.parentElement?.textContent, field.parentElement?.parentElement?.textContent]
        .filter(Boolean)
        .join(" ")
    );
    const wordMatch = nearbyText.match(/\b(\d{2,5})\s*words?\b/);
    if (wordMatch) return Number(wordMatch[1]);

    const charMatch = nearbyText.match(/\b(\d{2,6})\s*(characters?|chars?)\b/);
    if (charMatch) return Math.floor(Number(charMatch[1]) / 6); // rough chars-per-word estimate

    if (field.maxLength && field.maxLength > 0) return Math.floor(field.maxLength / 6);

    return null;
  }

  // The backend returns a structured object (header/greeting/body
  // paragraphs), not plain text — flattened here into what actually goes
  // in a textarea.
  function buildCoverLetterText(coverLetter) {
    return [coverLetter.greeting, coverLetter.body?.introduction, coverLetter.body?.experience, coverLetter.body?.skills, coverLetter.body?.closing]
      .filter(Boolean)
      .join("\n\n");
  }

  // Backstop against the field's own real constraint regardless of how
  // closely the AI's "aim for N words" instruction was actually followed —
  // an AI length instruction is a strong hint, not a guarantee.
  function truncateToWordLimit(text, wordLimit) {
    if (!wordLimit) return text;
    const words = text.split(/\s+/);
    return words.length <= wordLimit ? text : `${words.slice(0, wordLimit).join(" ")}...`;
  }

  // Shows the resume's pre-generated cover letter for a text-shaped
  // "Cover Letter" field — always review-before-insert, never auto-inserted.
  // Unlike OG, there's no on-demand generation call: the optimization flow
  // already generates one cover letter per resume version up front (see
  // ResumeVersion.coverLetter / ResumeVersionCard.tsx's "Cover letter"
  // button), fetched alongside the resume file in getResumeFileUrl() — this
  // just formats and word-limit-trims it, reusing the same helpers OG used
  // for its on-demand version.
  async function generateAndSuggestCoverLetter(field, fieldLabel) {
    if (!pendingHandoff?.candidateId) {
      recordResult("skipped", fieldLabel, 'Only available when applying via "Apply with Autofill" from the Consultant app');
      return;
    }

    const wordLimit = detectWordLimit(field);
    await getResumeFileUrl(); // ensures resumeCoverLetter is populated
    console.log("[AskJobs] cover letter available:", Boolean(resumeCoverLetter), "word limit detected:", wordLimit);

    if (!resumeCoverLetter) {
      recordResult("skipped", fieldLabel, "No cover letter available for this resume");
      return;
    }

    const coverLetterText = truncateToWordLimit(buildCoverLetterText(resumeCoverLetter), wordLimit);

    showSuggestionCard(fieldLabel, coverLetterText, true, (finalValue) => {
      typeCharacterByCharacter(field, finalValue);
      recordResult("filled", fieldLabel, "Cover letter (reviewed)");
    });
    recordResult(
      "skipped",
      fieldLabel,
      wordLimit ? `Found a cover letter (trimmed to ${wordLimit} words) — review and click Insert` : "Found a cover letter — review and click Insert"
    );
  }

  // Confirmed real: "Phone" showed up 3 times in the sidebar's list, all
  // reporting the identical value — this session alone involved many
  // repeated "Fill this application"/"AI-fill" clicks on the SAME
  // still-open job (chasing other bugs), and fieldResults never collapsed
  // a later call reporting the exact same field+value as an earlier one, so
  // every re-scan just appended another row (and kept inflating the
  // "N filled" counter). Deduping on label+detail together (not label
  // alone) is deliberate: repeated-entry sections legitimately record
  // several rows sharing a bare label like "Institution" within a SINGLE
  // scan (one per Education entry) — those have DIFFERENT detail values and
  // must stay distinct rows; only an exact repeat (same label, same value)
  // is the redundant case this exists to collapse.
  // recordResult is called from ~30 places throughout this file, unchanged
  // — it's now a thin dispatcher. In the top frame (where the sidebar
  // actually lives, see setHostPosition/injectSidebar) it renders directly,
  // same as always. In any other frame — a form living inside an iframe —
  // there's no local sidebar to render into at all, so the result is
  // relayed to the top frame over postMessage instead, where
  // recordResultLocal runs exactly the same rendering code.
  function recordResult(status, label, detail) {
    if (window.self !== window.top) {
      window.top.postMessage({ source: "askjobs-extension", type: "remote-field-result", status, label, detail }, "*");
      return;
    }
    recordResultLocal(status, label, detail);
  }

  function recordResultLocal(status, label, detail) {
    // Cheap check (isConnected) on every result — self-heals the sidebar if
    // an SPA re-render wiped it since injectSidebar()'s own initial call
    // (see that function's comment). No-ops instantly when it's still there.
    injectSidebar();
    const resolvedLabel = label || "Unlabeled field";
    const resolvedDetail = detail || "";
    const existingIndex = fieldResults.findIndex(
      (r) => r.label === resolvedLabel && r.detail === resolvedDetail
    );
    if (existingIndex !== -1) {
      const previous = fieldResults[existingIndex];
      if (previous.status === "filled") filledCount -= 1;
      else skippedCount -= 1;
      fieldResults[existingIndex] = { status, label: resolvedLabel, detail: resolvedDetail };
    } else {
      fieldResults.push({ status, label: resolvedLabel, detail: resolvedDetail });
    }
    if (status === "filled") filledCount += 1;
    else skippedCount += 1;
    updateSidebarCounter();
    renderFieldResults();
  }

  // Skills fields come in two common shapes and there's no reliable way to
  // tell which one from the DOM alone, so this detects it at runtime: type
  // the first skill + Enter, then check whether the field cleared itself.
  // A tag/chip input consumes the entry and empties for the next one; a
  // plain text/textarea field just keeps what was typed. Autocomplete-only
  // skill pickers (type, click a suggestion, no free typing accepted) are
  // out of scope — if neither shape is detected, this reports failure and
  // the caller flags it as "need attention" rather than claiming success.
  async function fillSkillsField(field) {
    if (!resumeSkills || resumeSkills.length === 0) {
      console.log("[AskJobs] skills: nothing to fill — resumeSkills is empty (no resume handoff/data for this session)");
      return false;
    }

    // Workday's "Type to Add Skills" is the same multiselect-search widget
    // as School/Field of Study — typing opens a checkbox-option dropdown
    // that must actually be clicked, Enter doesn't commit anything there.
    if (isMultiselectSearchBox(field)) {
      return fillMultiselectSearch(field, resumeSkills, labelForField(field) || "skills");
    }

    field.focus();
    field.dispatchEvent(new Event("focus", { bubbles: true, composed: true }));

    typeStringInto(field, resumeSkills[0]);
    dispatchEnterKey(field);
    field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await new Promise((resolve) => setTimeout(resolve, 150));

    const isTagInput = !field.value || field.value.trim() === "";

    if (isTagInput) {
      for (let i = 1; i < resumeSkills.length; i++) {
        typeStringInto(field, resumeSkills[i], { clearFirst: false });
        dispatchEnterKey(field);
        field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } else {
      // Plain text field — overwrite the first-skill-only value with the
      // full joined list instead of leaving just one skill typed in.
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value");
      descriptor.set.call(field, "");
      field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      typeStringInto(field, resumeSkills.join(", "), { clearFirst: false });
      field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }

    field.blur();
    field.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
    field.dispatchEvent(new Event("focusout", { bubbles: true, composed: true }));
    return true;
  }

  // Queues a field the deterministic matchers didn't recognize for the AI
  // classification fallback — only if it has a resolvable label long enough
  // to plausibly be a real question (same >=10-char heuristic already used
  // by collectUnansweredQuestions, to avoid scooping up stray cosmetic
  // fields with no label).
  function maybeQueueFieldForClassification(field, signature) {
    if (queuedFieldSignatures.has(signature)) return;
    const label = (
      labelForField(field) ||
      field.getAttribute("aria-label") ||
      field.getAttribute("placeholder") ||
      ""
    ).trim();
    if (label.length < 10 || label.length > MAX_QUESTION_LABEL_LENGTH) return;
    // Confirmed real (CATS One): a masked "Date Available" field got queued
    // here like any other unrecognized field and came back from the AI
    // pass with "Immediately" — a reasonable phrase, not a valid value for
    // a field that expects an actual calendar date. Free text can never be
    // a valid answer for a date-shaped field, so that path is closed off
    // entirely — but for the specific "when can you start" question, an
    // always-VALID default exists: today's own date, correctly formatted
    // for whatever this field expects (formatDateForField already handles
    // native type="date" vs. various masked placeholder formats). Still
    // review-before-insert, same as everything else — never auto-filled.
    if (isDateShapedField(field)) {
      const questionText = normalize(label);
      // "Start Date" is exactly as common a label on a degree/job entry
      // (when did you begin) as it is on a "when can you start work"
      // screening question — confirmed real: an Education entry's own
      // Start Date field (which EDUCATION_FIELD_MATCHERS has no key for,
      // since we only track graduationYear) got wrongly offered "today" as
      // if it were a job-availability date. Only apply the job-start
      // assumption outside a structural Education/Experience section.
      if (isStartDateQuestion(questionText) && !isInsideEducationOrExperienceSection(field)) {
        queuedFieldSignatures.add(signature);
        const todayFormatted = formatDateForField(field, new Date().toISOString());
        if (todayFormatted) {
          renderStoredValueSuggestion(label, `${todayFormatted} (today)`, () => {
            fillDateField(field, todayFormatted);
            recordResult("filled", label, `${todayFormatted} (today's date, reviewed)`);
          });
          recordResult("skipped", label, "Suggested today's date — review above and click Insert, or set an exact date directly");
        }
      }
      return;
    }

    // Gender/sensitive-demographic checks belong here too — confirmed
    // real: "Gender (International)" showed up on one Oracle Cloud page
    // as a radio group, on another as a plain <input type="text">, and
    // native <select> gender fields are already caught upstream by
    // fillScreeningSelect before this function is ever reached for them.
    // Every widget shape needs the same "use stored profile data, never
    // AI-guess" treatment, not just the ones already wired.
    const questionText = normalize(label);
    if (isGenderIdentityQuestion(questionText)) {
      queuedFieldSignatures.add(signature);
      const stored = profile?.gender;
      if (stored) {
        renderStoredValueSuggestion(label, stored, () => {
          if (field.tagName === "TEXTAREA") {
            typeCharacterByCharacter(field, stored);
          } else {
            setNativeValue(field, stored);
          }
          recordResult("filled", label, `${stored} (from your profile, reviewed)`);
        });
        recordResult("skipped", label, "Suggested from your profile — review above and click Insert");
      } else {
        recordResult("skipped", label, "Gender identity question — no gender set in your profile, please answer directly");
      }
      return;
    }
    if (isDisabilityQuestion(questionText)) {
      queuedFieldSignatures.add(signature);
      const stored = jobPreferences?.disabilityStatus;
      if (stored) {
        renderStoredValueSuggestion(label, stored, () => {
          if (field.tagName === "TEXTAREA") {
            typeCharacterByCharacter(field, stored);
          } else {
            setNativeValue(field, stored);
          }
          recordResult("filled", label, `${stored} (from your Settings, reviewed)`);
        });
        recordResult("skipped", label, "Suggested from your Settings — review above and click Insert");
      } else {
        recordResult("skipped", label, "Voluntary demographic question — set a disability status in Settings to get a suggestion, or answer directly");
      }
      return;
    }
    if (isSensitiveSelfIdQuestion(questionText)) {
      queuedFieldSignatures.add(signature);
      const stored = sensitiveSelfIdFreeText(questionText);
      if (stored) {
        renderStoredValueSuggestion(label, stored, () => {
          if (field.tagName === "TEXTAREA") {
            typeCharacterByCharacter(field, stored);
          } else {
            setNativeValue(field, stored);
          }
          recordResult("filled", label, `${stored} (from the candidate's EEO profile, reviewed)`);
        });
        recordResult("skipped", label, "Suggested from the candidate's EEO profile — review above and click Insert");
      } else {
        recordResult("skipped", label, "Voluntary demographic question — left for you to answer directly");
      }
      return;
    }

    queuedFieldSignatures.add(signature);
    const options = field.tagName === "SELECT"
      ? Array.from(field.options)
          .map((o) => o.textContent.trim())
          .filter((t) => t && !PLACEHOLDER_OPTION_TEXT.test(normalize(t)))
      : undefined;
    pendingClassificationItems.push({
      kind: "field",
      field,
      questionText: label,
      fieldType: field.tagName === "SELECT" ? "select" : field.type || "text",
      options,
    });
  }

  async function fillField(field) {
    const signature = fieldSignature(field);
    // placeholder sits before the final "Unlabeled field" fallback, not
    // before name/id/aria-label — those are still stronger signals when
    // present, but a field with none of them (confirmed real on Breezy:
    // Company/Title carry only a placeholder, no name/id/label at all)
    // shouldn't show as generic "Unlabeled field" in the sidebar when the
    // placeholder text is right there and already used to classify it.
    const fieldLabel = labelForField(field) || field.getAttribute("aria-label") || field.name || field.id || field.getAttribute("placeholder") || "Unlabeled field";
    // Already attempted this logical field once (regardless of whether the
    // current DOM node is the same object) — never touch it again. This is
    // what lets a manual clear stick instead of silently being refilled.
    if (attemptedSignatures.has(signature)) return;

    if (field.type === "file") {
      resumeFileInputFound = true;
      if (field.value) return;
      attemptedSignatures.add(signature);
      // A "cover letter" upload is a genuinely different document from the
      // resume — attaching the resume into it would be actively wrong, not
      // just unhelpful. Left for manual attachment for now; only a cover
      // letter TEXT field (below) gets AI-generated content.
      if (classify(field) === "coverLetter") {
        recordResult("skipped", fieldLabel, "Cover letter file upload — attach manually for now");
        return;
      }
      const attached = await attachResumeFile(field);
      recordResult(
        attached ? "filled" : "skipped",
        "Resume/CV",
        attached
          ? resumeIsFallbackPrimary
            ? "Attached your primary resume (no customized version for this job)"
            : "Attached automatically"
          : "Couldn't auto-attach — use the download link below"
      );
      if (!attached) showManualResumePrompt();
      return;
    }

    // Skip a field that already has content the first time we see it —
    // either pre-filled by the page itself or the user got there first.
    // Checkboxes/radios are excluded from this check: their `.value` is the
    // OPTION's value (e.g. "Night Job"), which is non-empty regardless of
    // whether the box is actually checked — confirmed real: a whole
    // standalone checkbox question ("shift preference") was silently
    // skipped here on every pass, never even reaching classification,
    // because every option's `.value` was truthy. Checkbox GROUPS are
    // handled by scanAndFillCheckboxGroups instead; native radios by
    // scanAndFillRadioGroups — this generic loop has nothing useful to do
    // with either type, so just leave them alone rather than bailing out
    // for the wrong reason.
    if (field.type === "checkbox" || field.type === "radio") return;
    // Confirmed real (Recruitee): a phone widget that auto-inserts the
    // selected country's dial code the moment it renders — this field's
    // value was already "+1" before the candidate had typed anything at
    // all. That's not a real phone number, just a prefix waiting for one;
    // treating it as "already filled" meant the field was silently skipped
    // forever. Only applies to a BARE prefix (just "+" and 1-4 digits,
    // nothing else) — a field that already has real digits after the
    // country code is a genuinely filled value and still left alone.
    const isBareDialCodePrefix = field.type === "tel" && /^\+\d{1,4}$/.test(field.value.trim());
    // A <select> with no explicit value="" on its placeholder option (e.g.
    // <option>-- No answer --</option>) defaults that option's .value to its
    // own text — so field.value reads as truthy ("-- No answer --") even
    // though nothing has actually been chosen. Confirmed real: "Do you have
    // 8+ years of experience with Power BI?" and "Are you based in LATAM?"
    // both got silently skipped here, never reaching classification or AI,
    // because their unanswered state looked like a real value.
    const isUnansweredSelect =
      field.tagName === "SELECT" &&
      PLACEHOLDER_OPTION_TEXT.test(normalize(field.selectedOptions?.[0]?.textContent || ""));
    if (field.value && !isBareDialCodePrefix && !isUnansweredSelect) {
      console.log("[AskJobs] generic field skipped (already has a value):", fieldLabel);
      return;
    }

    const key = classify(field);
    if (!key) {
      // A screening question (work auth, relocation, age, etc.) sometimes
      // renders as a plain native <select> rather than radios or a custom
      // combobox — check that before giving up and queueing this for
      // generic AI classification, which has no concept of a Yes/No
      // screening answer.
      if (field.tagName === "SELECT" && (await fillScreeningSelect(field, signature, fieldLabel))) {
        return;
      }
      console.log("[AskJobs] generic field not recognized:", fieldLabel);
      maybeQueueFieldForClassification(field, signature);
      return;
    }

    if (key === "skills") {
      attemptedSignatures.add(signature);
      const filled = await fillSkillsField(field);
      recordResult(
        filled ? "filled" : "skipped",
        fieldLabel,
        filled ? resumeSkills.join(", ") : "Couldn't fill — check the field manually"
      );
      console.log("[AskJobs] generic field (skills)", filled ? "filled" : "fill failed", ":", fieldLabel);
      return;
    }

    if (key === "coverLetter") {
      attemptedSignatures.add(signature);
      // AI generation only makes sense for a plain text box — a <select>
      // or other widget matching "cover letter" in its label (e.g. an
      // attach/skip dropdown) isn't something typeCharacterByCharacter can
      // meaningfully fill, and file inputs are already routed away from
      // this key entirely by the field.type === "file" branch above.
      const isTextBox = field.tagName === "TEXTAREA" || (field.tagName === "INPUT" && (field.type === "text" || field.type === ""));
      if (!isTextBox) {
        recordResult("skipped", fieldLabel, "Cover letter field isn't a plain text box — leaving as-is");
        return;
      }
      await generateAndSuggestCoverLetter(field, fieldLabel);
      return;
    }

    const value = valueForKey(key);
    if (!value) {
      console.log("[AskJobs] generic field recognized as", key, "but no data for it:", fieldLabel);
      return;
    }

    if (field.tagName === "SELECT") {
      const option = Array.from(field.options).find((o) =>
        normalize(o.textContent).includes(normalize(value))
      );
      if (option) {
        field.value = option.value;
        field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        attemptedSignatures.add(signature);
        recordResult("filled", fieldLabel, value);
        console.log("[AskJobs] generic field filled:", key, "=", value, "->", fieldLabel);
      } else {
        console.log("[AskJobs] generic field recognized as", key, "but no matching <option> for:", value, "->", fieldLabel);
      }
      return;
    }

    if (key === "dateOfBirth") {
      const finalValue = formatDateForField(field, value);
      if (!finalValue) return;
      // fillDateField picks the right technique — most date fields here are
      // masked/segmented text inputs, which need typing simulated
      // character-by-character, but a native <input type="date"> (confirmed
      // real: silently stayed empty when typed into that way) needs its
      // value set directly instead.
      fillDateField(field, finalValue);
      attemptedSignatures.add(signature);
      recordResult("filled", fieldLabel, finalValue);
      console.log("[AskJobs] generic field filled:", key, "=", finalValue, "->", fieldLabel);
      return;
    }

    // A bare dial-code prefix (e.g. "+1") is the widget's OWN state, not
    // something to overwrite — setNativeValue with just the digits would
    // silently drop the country code the widget had already set up.
    // Preserving it and appending the digits keeps the field as
    // "+1XXXXXXXXXX" instead of losing the "+1" entirely.
    const finalValue = key === "phone" && isBareDialCodePrefix ? `${field.value.trim()}${value}` : value;
    setNativeValue(field, finalValue);
    attemptedSignatures.add(signature);
    console.log("[AskJobs] generic field filled:", key, "=", finalValue, "->", fieldLabel);
    recordResult("filled", fieldLabel, finalValue);
    if (key === "phone") await fillNearbyCountrySelector(field);
  }

  // Clears every per-field dedup/queue tracker and the sidebar's own
  // display state — used only when a genuinely new application context is
  // detected (see below), never on an ordinary re-click of "Fill this
  // application" on the SAME form, where attemptedSignatures existing is
  // exactly what lets a manual clear stick instead of being silently
  // refilled.
  // Clears just the DISPLAY — fieldResults/counters/rendered DOM. Split out
  // from resetFillState below so the message listener can call this alone
  // when a non-top frame relays a reset: only the frame that actually did
  // the scanning should have its OWN dedup/queue trackers cleared (they're
  // per-frame state, unrelated to which frame the display happens to live
  // in), but the display itself only ever exists in the top frame.
  function resetDisplayLocal() {
    fieldResults.length = 0;
    filledCount = 0;
    skippedCount = 0;
    const resultsContainer = sidebarShadow?.querySelector("#askjobs-ai-results");
    if (resultsContainer) resultsContainer.innerHTML = "";
    renderFieldResults();
    updateSidebarCounter();
  }

  function resetFillState() {
    attemptedSignatures.clear();
    queuedFieldSignatures.clear();
    queuedRadioGroupNames.clear();
    attemptedRadioGroups.clear();
    attemptedCheckboxGroups.clear();
    queuedCheckboxGroupNames.clear();
    pendingClassificationItems = [];
    // Same dispatch pattern as recordResult — the display lives in the top
    // frame now, so a non-top frame relays the clear instead of touching a
    // local fieldResults array that recordResult never populates there in
    // the first place (it always relays too).
    if (window.self !== window.top) {
      window.top.postMessage({ source: "askjobs-extension", type: "remote-reset-results" }, "*");
      return;
    }
    resetDisplayLocal();
  }

  // Confirmed real (Greenhouse's MyGreenhouse candidate portal): clicking a
  // different job from a browse-jobs list opens a NEW "Apply for this job"
  // modal whose fields share the exact same name/id/label as the PREVIOUS
  // job's modal (same form template, reused across every job) — so their
  // computed signatures collide with ones already in attemptedSignatures
  // from the first application, and the second modal's fields got silently
  // skipped as "already handled" even though they were genuinely empty.
  // Signatures alone can't tell "same field, different job" apart from
  // "same field, re-rendered" (the scenario attemptedSignatures exists to
  // survive) — but DOM node IDENTITY can: if every currently-visible field
  // is a node this session has never seen before, that's a freshly-mounted
  // form, not the same one persisting, and it's safe to start over.
  function resetFillStateIfNewContext(fields) {
    if (fields.length === 0) return;
    const anyPreviouslySeen = fields.some((f) => seenFields.has(f));
    if (!anyPreviouslySeen && attemptedSignatures.size > 0) {
      console.log("[AskJobs] all", fields.length, "field(s) are unseen DOM nodes — new application context detected, resetting fill state");
      resetFillState();
    }
  }

  // True while a scanAndFill pass is actively running — lets the "new
  // fields detected" MutationObserver (see init()) tell the difference
  // between fields that appeared because the PAGE changed (a multi-step
  // form advancing, worth prompting a re-fill for) and fields that
  // appeared because THIS pass itself just clicked "Add Education"/"Add
  // Position" to reveal a repeated entry. Confirmed real: without this,
  // every "Fill this application" click immediately re-triggered its own
  // "New fields detected — click Fill again" prompt, since revealing
  // entries is a normal, expected part of every fill pass.
  let fillInProgress = false;

  async function scanAndFill(root) {
    fillInProgress = true;
    try {
      resetFillStateIfNewContext(deepQueryAll(root, "input, select, textarea, button"));

      // Runs before the generic per-field loop below so that, by the time it
      // reaches an education/experience field, it already has a value and is
      // skipped there — rather than the generic loop queueing it for AI
      // classification first and then this section filling it a moment later,
      // which would leave a stale AI suggestion offering to overwrite a
      // correct value that's already in the field.
      await fillEducationAndExperience();
      await fillCertifications();
      await fillWebsites();

      const fields = deepQueryAll(root, "input, select, textarea");
      for (const field of fields) {
        if (field.type === "hidden" || field.disabled) continue;
        // Deliberately NOT gated on seenFields here — that only tracks DOM
        // node identity for resetFillStateIfNewContext's "is this a fresh
        // modal" check below. Gating the actual fill attempt on it used to
        // mean a second explicit "Fill this application" click (sidebar or
        // popup) silently skipped every field it had ever looked at before,
        // even ones still empty because they failed the first time (no data,
        // no matching <option>, not yet classified) — confirmed real: only
        // fillWebsites()/fillEducationAndExperience()/fillCertifications()
        // above, which never had this gate, actually re-ran on a second
        // click. fillField()'s own attemptedSignatures + field.value checks
        // already prevent clobbering anything genuinely already filled or
        // edited by hand, so this loop doesn't need a second, cruder gate on
        // top of that.
        seenFields.add(field);
        await fillField(field);
      }
      await scanAndFillRadioGroups(root);
      await scanAndFillCheckboxGroups(root);
      await scanAndFillGenericComboboxes(root);
      await scanAndFillButtonToggleGroups(root);
      await runClassificationPass();
      await flagUnreachableResumeUploadIfNeeded();
    } finally {
      fillInProgress = false;
    }
  }

  // Resolves the overall question a group of radios/checkboxes is asking.
  // Real forms vary a LOT here (confirmed across three different ATS
  // platforms this session), so this tries three strategies in order,
  // each only used if the previous one comes up empty:
  //
  // 1. Nested fieldset -> legend (Workday: the legend can sit in an OUTER
  //    fieldset than the one immediately wrapping the options — walk up
  //    through nested fieldsets, not just the nearest one).
  // 2. Smallest container holding every option, with each option's own
  //    label text stripped out of it (Ashby: the question's own <label>
  //    is a direct child of the same fieldset as the options, no <legend>
  //    at all — this still finds it since it's a descendant of that
  //    shared container).
  // 3. One level further up from that container, same strip (Lever: the
  //    question text is a SIBLING of the options wrapper, not a
  //    descendant of it at all).
  function groupQuestionText(items) {
    let node = items[0].closest("fieldset");
    while (node) {
      const legend = node.querySelector("legend");
      if (legend?.textContent?.trim()) return legend.textContent.trim();
      node = node.parentElement?.closest("fieldset") || null;
    }

    const optionTexts = items.map((r) => normalize(labelForField(r) || r.value || ""));
    function strippedText(container) {
      if (!container) return "";
      let text = normalize(container.textContent || "");
      for (const opt of optionTexts) {
        if (opt) text = text.replace(opt, "");
      }
      return text.trim();
    }

    let container = items[0].parentElement;
    while (container && !items.every((r) => container.contains(r))) {
      container = container.parentElement;
    }
    let text = strippedText(container);
    if (text.length >= 10) return text;

    let outer = container?.parentElement;
    for (let i = 0; i < 3 && outer; i++) {
      text = strippedText(outer);
      if (text.length >= 10) return text;
      outer = outer.parentElement;
    }

    return text;
  }

  // Deterministic (no AI) answer for a matched radio-question key, sourced
  // from stored preferences (Settings → Screening Questions) or, for
  // "worked here before," derived per-application from resume history —
  // never stored, genuinely computed each time against the current job.
  function radioAnswerForKey(key) {
    if (key === "workedHereBefore") {
      const targetCompany = pendingHandoff?.companyName;
      if (!targetCompany) return null;
      // Confirmed real bug: this used to bail out to null ("can't answer")
      // whenever experience was empty, even though an empty work history
      // is itself a confident "No" — you can't have worked at this
      // specific company if you've never worked anywhere at all. Only a
      // genuinely missing company NAME (not missing history) should stay
      // unanswerable.
      if (!profile?.experience?.length) return false;
      const target = normalize(targetCompany);
      if (!target) return null;
      const worked = profile.experience.some((exp) => {
        const company = normalize(exp.company || "");
        return company && (company.includes(target) || target.includes(company));
      });
      return worked;
    }

    // Computed straight from the profile, not a stored preference — the
    // question is really "is the candidate's age >= 18", and we already
    // have the one piece of data that answers it directly.
    if (key === "atLeast18") {
      if (!profile?.dateOfBirth) return null;
      const dob = new Date(profile.dateOfBirth);
      if (Number.isNaN(dob.getTime())) return null;
      const now = new Date();
      let age = now.getFullYear() - dob.getFullYear();
      const hadBirthdayThisYear =
        now.getMonth() > dob.getMonth() ||
        (now.getMonth() === dob.getMonth() && now.getDate() >= dob.getDate());
      if (!hadBirthdayThisYear) age -= 1;
      return age >= 18;
    }

    const prefs = jobPreferences || {};

    // Defaults to Yes unless explicitly set to false in Settings — most
    // candidates are applying to jobs in their own country and are
    // eligible by default; this only answers No if the user has actively
    // told us otherwise, rather than staying unanswered forever just
    // because the preference was never touched in Settings.
    if (key === "workAuthorized") {
      const v = prefs.workAuthorized;
      return typeof v === "boolean" ? v : true;
    }

    if (key === "visaSponsorshipNeeded" || key === "willingToRelocate") {
      const v = prefs[key];
      return typeof v === "boolean" ? v : null;
    }
    return null;
  }

  // Screening questions (work auth, relocation, age, etc.) don't always
  // render as radios or a custom combobox button — confirmed real: the same
  // question type also shows up as a plain native <select>. Checked against
  // the SAME RADIO_MATCHERS/radioAnswerForKey logic used for those other
  // widget shapes, so it doesn't matter which one a given site happens to
  // use. Returns true if this field was a recognized screening question at
  // all (whether or not it could actually be filled) — false only means
  // "not a screening question," so the caller knows whether to fall through
  // to generic AI classification instead.
  // Resolves a stored value against a field's ACTUAL rendered option texts —
  // exact/synonym match first (quickMatch, when the caller has one), falling
  // back to aiPickBestOption (the same AI dropdown-matching already used for
  // custom comboboxes via waitForBestMatchingOption) whenever that comes up
  // empty. Confirmed real gap this closes: native <select>/radio widgets
  // previously had ONLY the hardcoded synonym lists — a gender dropdown
  // offering "Man"/"Woman" instead of "Male"/"Female" worked by luck of
  // being in that list, but a "Race" option worded differently than the
  // stored value ("Asian" vs. "Asian (incl. Indian subcontinent)"), or any
  // stored value with no synonym list at all (veteran status, ethnicity),
  // had nothing to fall back to and just gave up. Never invents an option
  // that wasn't actually offered — aiPickBestOption is scoped to exactly the
  // option texts passed in.
  async function resolveOptionMatch(fieldLabel, storedValue, optionTexts, quickMatch) {
    if (quickMatch) return quickMatch;
    if (!storedValue || optionTexts.length === 0) return null;
    return aiPickBestOption(fieldLabel, storedValue, optionTexts);
  }

  async function fillScreeningSelect(field, signature, fieldLabel) {
    if (fieldLabel.length > MAX_QUESTION_LABEL_LENGTH) return false;
    const questionText = normalize(fieldLabel);

    if (isGenderIdentityQuestion(questionText)) {
      const optionTexts = Array.from(field.options).map((o) => o.textContent.trim()).filter(Boolean);
      const suggestion = await resolveOptionMatch(fieldLabel, profile?.gender, optionTexts, bestGenderOptionText(optionTexts));
      if (suggestion) {
        renderStoredValueSuggestion(fieldLabel, suggestion, () => {
          const option = Array.from(field.options).find((o) => o.textContent.trim() === suggestion);
          if (option) {
            field.value = option.value;
            field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            recordResult("filled", fieldLabel, `${suggestion} (from your profile, reviewed)`);
          }
        });
        recordResult("skipped", fieldLabel, "Suggested from your profile — review above and click Insert");
      } else {
        recordResult("skipped", fieldLabel, "Gender identity question — no matching option found for your stored profile value, please answer directly");
      }
      return true;
    }

    if (isDisabilityQuestion(questionText)) {
      const optionTexts = Array.from(field.options).map((o) => o.textContent.trim()).filter(Boolean);
      const suggestion = await resolveOptionMatch(
        fieldLabel,
        jobPreferences?.disabilityStatus,
        optionTexts,
        bestDisabilityOptionText(optionTexts),
      );
      if (suggestion) {
        renderStoredValueSuggestion(fieldLabel, suggestion, () => {
          const option = Array.from(field.options).find((o) => o.textContent.trim() === suggestion);
          if (option) {
            field.value = option.value;
            field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            recordResult("filled", fieldLabel, `${suggestion} (from your Settings, reviewed)`);
          }
        });
        recordResult("skipped", fieldLabel, "Suggested from your Settings — review above and click Insert");
      } else {
        recordResult("skipped", fieldLabel, "Voluntary demographic question — set a disability status in Settings to get a suggestion, or answer directly");
      }
      return true;
    }

    if (isSensitiveSelfIdQuestion(questionText)) {
      const stored = sensitiveSelfIdSingleValue(questionText);
      const optionTexts = Array.from(field.options).map((o) => o.textContent.trim()).filter(Boolean);
      const normStored = stored ? normalize(stored) : "";
      const quickMatch = stored
        ? optionTexts.find((t) => normalize(t).includes(normStored) || normStored.includes(normalize(t)))
        : null;
      const matchedOption = await resolveOptionMatch(fieldLabel, stored, optionTexts, quickMatch);
      if (matchedOption) {
        renderStoredValueSuggestion(fieldLabel, matchedOption, () => {
          const option = Array.from(field.options).find((o) => o.textContent.trim() === matchedOption);
          if (option) {
            field.value = option.value;
            field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            recordResult("filled", fieldLabel, `${matchedOption} (from the candidate's EEO profile, reviewed)`);
          }
        });
        recordResult("skipped", fieldLabel, "Suggested from the candidate's EEO profile — review above and click Insert");
        return true;
      }
      recordResult("skipped", fieldLabel, "Voluntary demographic question — left for you to answer directly");
      return true;
    }

    const matcher = matchRadioQuestion(questionText);
    if (!matcher) return false;

    const answer = radioAnswerForKey(matcher.key);
    if (answer === null) {
      recordResult("skipped", fieldLabel, "Recognized, but no stored preference set yet");
      return true;
    }

    const wantedText = answer ? "yes" : "no";
    const option = Array.from(field.options).find((o) => {
      const label = normalize(o.textContent);
      return label === wantedText || label.startsWith(wantedText);
    });
    if (!option) {
      recordResult("skipped", fieldLabel, "Couldn't find a matching Yes/No option");
      return true;
    }

    field.value = option.value;
    field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    attemptedSignatures.add(signature);
    recordResult("filled", fieldLabel, answer ? "Yes" : "No");
    return true;
  }

  // Same native-setter-override discipline as setNativeValue, applied to
  // `checked` instead of `value` — frameworks track checkbox/radio state via
  // the same kind of intercepted property setter.
  function setNativeChecked(radio) {
    const proto = Object.getPrototypeOf(radio);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "checked");

    radio.focus();
    radio.dispatchEvent(new Event("focus", { bubbles: true, composed: true }));
    descriptor.set.call(radio, true);
    radio.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    radio.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    radio.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    radio.blur();
    radio.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
    radio.dispatchEvent(new Event("focusout", { bubbles: true, composed: true }));
  }

  // ---- Education & Work Experience (first entry only) ----
  // profile.education[]/experience[] already exist (parsed from the user's
  // resume) with real structured data — this is genuinely new deterministic
  // support, not a classify-fields concern, since these are per-entry array
  // fields with no single "known key" to fall back to.
  //
  // Scope for this pass: only the FIRST entry of each section. Repeated
  // entries (2nd job, 2nd degree) need "Add"-button automation whose
  // behavior varies too much across ATS platforms to safely generalize yet
  // — left as a flagged follow-up, not silently dropped.
  const EDUCATION_FIELD_MATCHERS = [
    { key: "institution", patterns: ["school", "university", "institution", "college"] },
    { key: "degree", patterns: ["degree"] },
    { key: "field", patterns: ["field of study", "major", "specialization", "discipline"] },
    // "lastyearattended" targets Workday's own field id directly (confirmed
    // via real HTML: id="...-lastYearAttended-dateSectionYear-input" — its
    // own accessible label is just the generic "Year", shared with the
    // "firstYearAttended" field, so label text alone can't tell them apart).
    // "firstYearAttended" deliberately has no matcher — we don't store when
    // someone STARTED at an institution, only when they graduated.
    { key: "graduationYear", patterns: ["graduation year", "year of passing", "completion year", "year of graduation", "completion date", "graduation date", "lastyearattended"] },
    { key: "gpa", patterns: ["gpa", "cgpa", "overall result", "percentage", "grade"] },
  ];

  const EXPERIENCE_FIELD_MATCHERS = [
    { key: "title", patterns: ["job title", "position", "role title", "title"] },
    { key: "company", patterns: ["company", "employer", "organization"] },
    { key: "location", patterns: ["location", "city"] },
    { key: "startDate", patterns: ["from", "start date", "started"] },
    { key: "endDate", patterns: ["to", "end date", "ended"] },
    { key: "description", patterns: ["description", "responsibilities", "summary", "duties"] },
  ];

  const CURRENT_POSITION_PATTERNS = ["currently work here", "current position", "i currently work", "present"];

  // Certifications and Websites both render zero entry fields until "Add"
  // is clicked (confirmed via real HTML, same shape as Work Experience) —
  // handled the same way via revealFirstEntryIfNeeded before filling.
  const CERTIFICATION_FIELD_MATCHERS = [
    { key: "name", patterns: ["certification name", "certificate name", "credential name", "name", "title"] },
    { key: "issuer", patterns: ["issuing organization", "issuer", "organization", "issued by"] },
    { key: "date", patterns: ["issue date", "date issued", "date"] },
    { key: "url", patterns: ["credential url", "certificate url", "url", "link"] },
    { key: "certificateId", patterns: ["credential id", "certificate id", "license number", "certification id"] },
  ];

  // profile.websites (built by adaptCandidateProfile()) is a flat array of
  // URL strings, not objects — mapped to {url: ...} entries at the call site
  // so it fits the same entries-array shape fillRepeatedEntries expects.
  const WEBSITE_FIELD_MATCHERS = [{ key: "url", patterns: ["website", "url", "link"] }];

  const SECTION_PATTERNS = {
    education: ["education", "academic background", "qualifications"],
    experience: ["work experience", "employment", "professional experience", "experience"],
    certifications: ["certifications", "certification", "licenses", "credentials"],
    websites: ["websites", "website", "personal links"],
  };

  // Word-boundary match, not plain substring — needed for short/ambiguous
  // tokens like "to"/"from"/"gpa" that would otherwise false-match inside
  // unrelated words (e.g. "gpa" substring-matching inside "propaganda").
  function matchesWholeWord(haystack, pattern) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(haystack);
  }

  function classifyStructured(field, matchers) {
    // Tiered, not blended into one flat haystack: a real name/id/aria-label/
    // resolved-label match always wins over placeholder, which is checked
    // only as a last resort. Confirmed real on Breezy: Work History's Start
    // and End date inputs both carry a leftover placeholder="Company" (a
    // copy-paste artifact), which used to falsely win against "company"
    // before either date field's own real label (a plain-text sibling span,
    // not a <label>) ever got a chance to match "startDate"/"endDate".
    const strongText = normalize(
      [field.name, field.id, field.getAttribute("aria-label"), labelForField(field)].join(" ")
    );
    for (const matcher of matchers) {
      if (matcher.patterns.some((p) => matchesWholeWord(strongText, p))) return matcher.key;
    }
    const placeholderText = normalize(field.getAttribute("placeholder") || "");
    for (const matcher of matchers) {
      if (matcher.patterns.some((p) => matchesWholeWord(placeholderText, p))) return matcher.key;
    }
    return null;
  }

  // Locates the section's container, preferring the ARIA group landmark
  // pattern (`role="group"` + `aria-labelledby`) confirmed on a real Workday
  // form, with a plain-heading fallback for sites that don't use it — this
  // is a general accessible-forms pattern, not Workday-specific.
  // A real Education/Experience/Certifications/Websites section container
  // never legitimately holds this many form fields — confirmed real bug:
  // on an Oracle Cloud "Application Questions" page (23 unrelated Yes/No
  // questions, nothing to do with education at all), some ancestor's
  // heading/aria-label text happened to contain a whole-word match for
  // "qualifications" (SPA apps often keep earlier steps' content, like the
  // original job posting's "Qualifications" blurb, mounted in the DOM even
  // after navigating past it), and the fallback returned a container
  // wrapping most of the entire page — 74 fields, all mismatched against
  // education data. Rejecting any candidate this large is a blunt but
  // effective backstop against that whole class of false-positive, on any
  // site, regardless of what text happens to cause it.
  const MAX_PLAUSIBLE_SECTION_FIELDS = 40;

  function isPlausibleSectionContainer(container, sectionKey, matchedVia, matchedText) {
    const fieldCount = deepQueryAll(container, "input, select, textarea").length;
    // Confirmed real (Recruitee): the absolute 40-field cap alone wasn't
    // enough — on a genuinely SMALL form (well under 40 fields total), the
    // whole form's own wrapper can slip through as a "plausible" match for
    // whatever section pattern happened to match a heading/aria-label
    // somewhere on the page, sweeping in completely unrelated fields (Full
    // Name, Email, CV upload, Cover letter) as if they were repeated
    // entries of that section — each then ALSO got correctly picked up and
    // filled by the normal generic field scan, so the sidebar showed every
    // one of them twice: once as "Not recognized as a known field" from
    // this wrongly-matched section, once as the real filled result. No
    // genuine sub-section should ever contain MOST of the page's own
    // fields — only an accidentally-matched whole-form container would.
    // Comparing against the page's own total field count catches this
    // regardless of how large or small the form is, not just large ones.
    const totalPageFields = deepQueryAll(document, "input, select, textarea").length;
    const tooLargeAbsolute = fieldCount > MAX_PLAUSIBLE_SECTION_FIELDS;
    const tooLargeRelative = totalPageFields > 0 && fieldCount > totalPageFields * 0.6;
    if (tooLargeAbsolute || tooLargeRelative) {
      console.log(
        `[AskJobs] findSectionContainer("${sectionKey}"): rejected a match via ${matchedVia} ("${matchedText}") — ${fieldCount}/${totalPageFields} fields is implausibly large for a single section, likely matched unrelated page content`
      );
      return false;
    }
    console.log(`[AskJobs] findSectionContainer("${sectionKey}"): matched via ${matchedVia} ("${matchedText}"), ${fieldCount} field(s)`);
    return true;
  }

  // Presents a fixed set of real, still-attached DOM elements as one
  // combined querySelector(All) scope, without moving any of them out of
  // the page (which would break Angular/React bindings on live nodes).
  // querySelectorAll delegates to each element in turn and concatenates —
  // sufficient for every call site in this file, none of which need a
  // single unified root.
  function makeSiblingSetContainer(elements) {
    return {
      querySelectorAll(selector) {
        const results = [];
        for (const el of elements) {
          if (el.matches(selector)) results.push(el);
          results.push(...el.querySelectorAll(selector));
        }
        return results;
      },
      querySelector(selector) {
        for (const el of elements) {
          if (el.matches(selector)) return el;
          const found = el.querySelector(selector);
          if (found) return found;
        }
        return null;
      },
      contains(node) {
        return elements.some((el) => el === node || el.contains(node));
      },
    };
  }

  // True only for a heading recognized as one of THIS file's own tracked
  // section boundaries (education/experience/certifications/websites) —
  // the same dictionary already used to locate the section in the first
  // place, not a new site-specific list. A sub-heading that isn't one of
  // these (e.g. "Work History" nested under "Experience") is real content
  // belonging to its enclosing section, not a boundary of its own.
  function isKnownSectionHeadingText(text) {
    return Object.values(SECTION_PATTERNS).some((patterns) => patterns.some((p) => matchesWholeWord(text, p)));
  }

  // Finds a heading's real section content when there's no wrapping
  // fieldset/section to rely on. Confirmed real on Breezy: "Education" is
  // just <div class="section-header"><h3>Education</h3></div> — a thin
  // wrapper around the heading alone — with the actual entry list and "Add
  // Education" link living as FLAT SIBLINGS of that wrapper, not
  // descendants, and with "Work History" and "Experience Summary" as
  // further flat siblings on either side (same shared parent, no dedicated
  // wrapper per section at all). Walking up to that shared parent would
  // sweep in all three sections at once — confirmed real: Education's
  // "structured section" scan picked up Work History's Company/Title/
  // Summary/date fields this way. Instead, walk forward through siblings
  // starting at the heading's own wrapper, stopping at the next sibling
  // that contains one of this file's OWN recognized section headings —
  // stopping at literally any heading is too broad, since "Work History"
  // is itself an h3 sub-heading that belongs inside "Experience", not a
  // boundary (confirmed real: naive any-heading stop cut Experience off
  // right after its own <h2>, before ever reaching Work History's fields).
  function findFlatSectionContent(heading) {
    const headerWrapper = heading.parentElement;
    if (!headerWrapper) return null;
    if (
      headerWrapper.querySelector("input, select, textarea") ||
      Array.from(headerWrapper.querySelectorAll("button, a, [role='button']")).some((el) =>
        /\badd\b/i.test((el.textContent || "").trim())
      )
    ) {
      return headerWrapper;
    }

    const headingSelector = "h1, h2, h3, h4, h5, h6, legend";
    const siblings = [headerWrapper];
    let node = headerWrapper.nextElementSibling;
    while (node) {
      const nextHeading = node.matches(headingSelector) ? node : node.querySelector(headingSelector);
      if (nextHeading && isKnownSectionHeadingText(normalize(nextHeading.textContent || ""))) break;
      siblings.push(node);
      node = node.nextElementSibling;
    }
    return siblings.length > 1 ? makeSiblingSetContainer(siblings) : headerWrapper;
  }

  function findSectionContainer(sectionKey) {
    const patterns = SECTION_PATTERNS[sectionKey];

    const groups = deepQueryAll(null, "[role='group']");
    for (const group of groups) {
      const labelledBy = group.getAttribute("aria-labelledby");
      const labelEl = labelledBy ? document.getElementById(labelledBy) : null;
      const combined = normalize(`${labelEl?.textContent || labelledBy || ""} ${group.getAttribute("aria-label") || ""}`);
      if (patterns.some((p) => matchesWholeWord(combined, p)) && isPlausibleSectionContainer(group, sectionKey, "role=group", combined)) {
        return group;
      }
    }

    const headings = deepQueryAll(null, "h1, h2, h3, h4, h5, h6, legend");
    for (const heading of headings) {
      const text = normalize(heading.textContent || "");
      if (!patterns.some((p) => matchesWholeWord(text, p))) continue;
      const candidate = heading.closest("fieldset, section") || findFlatSectionContent(heading);
      if (candidate && isPlausibleSectionContainer(candidate, sectionKey, "heading", text)) {
        return candidate;
      }
    }
    return null;
  }

  // Whether a field structurally belongs to the Education or Experience
  // section, independent of whether classifyStructured recognizes its
  // specific purpose — a field can sit inside one of these sections
  // without EDUCATION_FIELD_MATCHERS/EXPERIENCE_FIELD_MATCHERS having a key
  // for it at all (e.g. an education entry's own "Start Date"), and still
  // needs to be treated as belonging to that context rather than as a
  // generic, top-level question.
  function isInsideEducationOrExperienceSection(field) {
    return [findSectionContainer("education"), findSectionContainer("experience")].some((container) =>
      container?.contains?.(field)
    );
  }

  async function fillStructuredField(field, value, fieldLabel, key) {
    const stringValue = String(value);
    if (field.tagName === "SELECT") {
      const option = Array.from(field.options).find((o) => normalize(o.textContent).includes(normalize(stringValue)));
      if (!option) return false;
      field.value = option.value;
      field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return true;
    }
    if (field.type === "date") {
      const finalValue = formatDateForField(field, stringValue);
      if (!finalValue) return false;
      // Confirmed real: this branch already KNOWS field.type is "date" —
      // typeCharacterByCharacter is for masked/segmented TEXT fields, whose
      // JS mask handler needs each keystroke; a native date input has its
      // own segment-by-segment interaction and silently stayed empty when
      // typed into this way instead. setNativeValue (inside fillDateField)
      // sets it directly, correctly, like any other native form control.
      fillDateField(field, finalValue);
      return true;
    }
    if (isMultiselectSearchBox(field)) {
      return fillMultiselectSearch(field, [stringValue], fieldLabel, { fallbackToOther: key === "institution" });
    }
    // role="spinbutton" year/date fields (confirmed via real HTML: a
    // separate decorative "YYYY" display div sits alongside the real
    // input) are the same segmented-input shape that caused the "10/10/0010"
    // masked-date bug — bulk-setting the value bypasses their internal
    // per-keystroke state the same way, so type it out instead.
    if (field.getAttribute("role") === "spinbutton") {
      typeCharacterByCharacter(field, stringValue);
      return true;
    }
    // A custom combobox trigger (role="combobox"/aria-haspopup="listbox" on
    // an <input>, not caught by the Workday-specific isMultiselectSearchBox
    // check above) needs an actual option clicked through fillCustomCombobox
    // — not a raw value set. Confirmed real (SAP SuccessFactors): setting
    // .value directly made the field LOOK filled for a moment, but the
    // widget's own validation reverted it to "No Selection" since nothing
    // was genuinely selected through its expected interaction, while this
    // function still returned true and the sidebar wrongly reported
    // "filled." fillCustomCombobox actually opens the list and looks for a
    // matching option, so a genuine non-match now correctly comes back
    // false instead of a false-positive success.
    if (isComboboxField(field)) {
      return await fillCustomCombobox(field, stringValue, fieldLabel);
    }
    setNativeValue(field, stringValue);
    return true;
  }

  // Confirmed real (Greenhouse's phone/country combobox): "No country
  // selected" doesn't match any of the original patterns, so it was
  // treated as a genuine already-filled answer and silently skipped —
  // every unfilled-state phrasing a widget might use needs to be
  // recognized, not just the "Select..."-style ones seen so far.
  const PLACEHOLDER_OPTION_TEXT = /^(select( one)?|choose( one)?|please select|no .+ selected|none selected|not selected|no answer)$/;

  function isVisible(el) {
    if (typeof el.checkVisibility === "function") return el.checkVisibility();
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // A real, pickable dropdown option — not an already-selected chip.
  // Confirmed via real HTML: Workday's multiselect keeps role="option" on a
  // selected chip permanently (data-automation-id="selectedItem"), distinct
  // from an actual dropdown option (data-automation-id="menuItem"). This is
  // a second, permanent guard alongside the before/after existingOptions
  // snapshot used elsewhere — belt and suspenders against the same class of
  // stale-chip contamination bug.
  function isRealOptionCandidate(el) {
    return isVisible(el) && el.getAttribute("data-automation-id") !== "selectedItem";
  }

  // Crude singularizer (strips a trailing "s") — good enough for the plural
  // mismatch this exists to fix, not a real stemmer.
  function singularize(word) {
    return word.replace(/s$/, "");
  }

  // Degree-LEVEL synonym groups — "B.Tech", "Bachelor of Technology", "BE",
  // and "Bachelors" are all the same level of degree, just named
  // differently across resumes/sites. Checked before the AI fallback so the
  // common case doesn't depend on a network round-trip at all; if one name
  // in a group isn't present as an option, another one in the same group
  // might be, so this checks the whole group, not just the literal target
  // text.
  const DEGREE_LEVEL_SYNONYMS = [
    { synonyms: ["bachelor", "bachelors", "btech", "b tech", "be", "bsc", "ba", "bcom", "bca", "bachelor of technology", "bachelor of engineering", "bachelor of science", "bachelor of arts", "bachelor of commerce", "undergraduate", "graduate"] },
    { synonyms: ["master", "masters", "mtech", "m tech", "me", "msc", "ma", "mcom", "mca", "mba", "master of technology", "master of engineering", "master of science", "master of arts", "master of commerce", "master of business administration", "postgraduate"] },
    { synonyms: ["phd", "doctorate", "doctoral"] },
    { synonyms: ["high school", "secondary", "12th", "xii", "intermediate", "hsc", "senior secondary"] },
    { synonyms: ["associate", "associates", "diploma", "polytechnic"] },
  ];

  function findDegreeSynonymGroup(text) {
    const normalized = normalize(text);
    return DEGREE_LEVEL_SYNONYMS.find((group) => group.synonyms.some((s) => matchesWholeWord(normalized, s)));
  }

  function degreeSynonymsMatch(optionText, targetText) {
    const optionGroup = findDegreeSynonymGroup(optionText);
    const targetGroup = findDegreeSynonymGroup(targetText);
    return !!optionGroup && optionGroup === targetGroup;
  }

  // Word-level, plural-insensitive overlap check — for combobox options
  // that name a CATEGORY/LEVEL ("Bachelors") rather than the specific value
  // stored in the profile ("Bachelor of Technology"). Plain substring
  // matching fails there (the profile's phrase never contains "Bachelors"
  // verbatim), so this instead checks whether any meaningfully long word
  // from the option also appears in the target, ignoring the trailing "s".
  // Restricted to SHORT option text (<=3 words) — confirmed a real bug
  // without this: a long option like "Keshav Memorial Institute of
  // Technology" shares the single word "Technology" with a target like
  // "Bachelor of Technology" and would otherwise false-match. Real
  // category-style options (Bachelors, High School, Doctorate) are always
  // short, so this loses nothing by excluding long ones.
  function comboboxTextsMatch(optionText, targetNormalized) {
    const optionWords = normalize(optionText).split(" ").map(singularize).filter(Boolean);
    if (optionWords.length > 3) return false;
    const targetWords = targetNormalized.split(" ").map(singularize).filter(Boolean);
    return optionWords.some((w) => w.length > 3 && targetWords.includes(w));
  }

  function closeComboboxPopup(button) {
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  }

  // Confirmed real via actual HTML (Remote's Greenhouse-hosted application
  // form): react-select's <input role="combobox"> opens its menu on
  // mousedown, not on a plain click — element.click() only ever synthesizes
  // a "click" event, never the mousedown/mouseup pair a real pointer
  // interaction produces, so react-select's onMouseDown-based open handler
  // never fired and every option-read against these fields found nothing,
  // even though clicking it by hand worked fine. Firing the full
  // mousedown -> mouseup -> click sequence (what a real click naturally
  // produces) is what actually opens/toggles-closed this class of widget;
  // it's also a strict superset of a bare click for widgets that only
  // needed click() (Workday's native <button>, Darwinbox's div[role=combobox]),
  // so this replaces every plain button.click() used to open/close a
  // combobox rather than being a special case for react-select only.
  function clickComboboxTrigger(button) {
    button.focus();
    const opts = { bubbles: true, cancelable: true, view: window };
    button.dispatchEvent(new MouseEvent("mousedown", opts));
    button.dispatchEvent(new MouseEvent("mouseup", opts));
    button.click();
  }

  // Force-closes any currently-open dropdown/listbox popup, no specific
  // button in mind. Confirmed necessary: the Degree combobox has no
  // aria-controls attribute, so it searches for options globally rather
  // than scoped to its own popup — if a PREVIOUS field's search failed and
  // left its own dropdown open (fillMultiselectSearch used to only clear
  // the search box on failure, never actually close the popup), that
  // leftover dropdown's options were still visible when Degree's global
  // search ran right after, and could get picked up as a false match.
  // Called before opening any new popup and after any failed match.
  //
  // Confirmed real, serious bug (Greenhouse's MyGreenhouse candidate
  // portal): this used to also simulate a page-wide "click outside"
  // (mousedown/mouseup/click on document.body) to dismiss floating-UI
  // dropdowns that don't respond to Escape alone. That's indistinguishable
  // from a genuine outside-click to a modal's own dismiss-on-outside-click
  // listener — the "Apply for this job" modal itself closed every time
  // this ran, wiping out the in-progress application. There's no way to
  // aim a simulated body click at "just this dropdown" without risking
  // exactly that collision, so it's gone entirely — Escape (dispatched to
  // whatever's currently focused, which is the correctly-scoped signal for
  // "close the thing I'm interacting with") plus an explicit blur is what's
  // left. This may leave the occasional stray multiselect dropdown open
  // longer than before; that's a strictly better trade than silently
  // closing the candidate's application.
  function closeAnyOpenPopup() {
    // Confirmed real (same Greenhouse portal, after removing the body-click
    // AND the .blur() that were here before): even a bare Escape keydown,
    // dispatched only to whatever's currently focused, still closed the
    // "Apply for this job" modal — Greenhouse's confirmed use of Radix UI
    // Dialog (see the "DialogContent requires a DialogTitle" warning seen
    // in the console) means the dialog itself likely has its own
    // Escape-to-close listener, which a bubbling Escape from a focused
    // descendant reaches just as well as one dispatched to the dialog
    // directly. There is no way to scope Escape so it can only reach "the
    // dropdown I actually want closed" and not also an ancestor modal —
    // every signal tried (click-outside, blur, Escape) turned out to be
    // exactly the signal some host page's own dismiss/leave-guard listens
    // for. This is now a deliberate no-op: a leftover open dropdown
    // occasionally contaminating a later field's search is a real but
    // minor annoyance; silently closing the candidate's in-progress
    // application is not an acceptable trade for avoiding it.
  }

  // Some role="option" rows (confirmed via real HTML: Workday's checkbox-
  // style multiselect list, used for Skills) aren't themselves the real
  // toggle target — they wrap a genuine <input type="checkbox"> (or,
  // plausibly, type="radio" for a conceptually single-select field like
  // School/Field of Study rendered through this same shared widget)
  // several levels deep, and that's what actually needs to be clicked.
  // Clicking the outer row worked for the single-select listbox case
  // (Degree, School's "Other" option) but silently did nothing for Skills,
  // which is why it looked like it "found" the right option (highlighted)
  // without ever actually checking it.
  function clickMatchedOption(option) {
    const toggle = option.querySelector('input[type="checkbox"], input[type="radio"]');
    if (toggle) {
      toggle.click();
    } else {
      option.click();
    }
  }

  // Asks the backend which of the dropdown's ACTUAL rendered option texts
  // best represents the target value — used only as a fallback once plain
  // text matching fails, for cases like a Workday degree LEVEL list
  // ("High School"/"Bachelors"/"Doctorate") against an Indian-education
  // value like "12th / HSC / Intermediate", where no amount of word-overlap
  // captures the mapping. Sends only the option texts + target value, never
  // the page or unrelated profile data.
  async function aiPickBestOption(fieldLabel, targetValue, optionTexts) {
    const response = await sendMessage({
      type: "API_FETCH",
      path: "/api/v1/extension/match-dropdown-options",
      options: {
        method: "POST",
        body: JSON.stringify({ items: [{ fieldLabel, targetValue, options: optionTexts }] }),
      },
    });
    if (!response?.ok) {
      console.warn("[AskJobs] match-dropdown-options failed:", response);
      return null;
    }
    return response.data?.matches?.[0] || null;
  }

  // Waits for a popup's role="option" items to render (they appear
  // asynchronously after opening/typing), then returns the best match: text
  // heuristics first, falling back to an AI pick against the options that
  // actually rendered (never invents an option that wasn't shown). Shared by
  // the button-triggered combobox (Degree) and the type-to-search
  // multiselect widget (School, Field of Study, Skills) — same underlying
  // "async listbox of options" shape, different trigger.
  //
  // `excludeOptions` filters out elements that already existed as
  // role="option" BEFORE this specific interaction started — confirmed
  // necessary: a field's already-SELECTED chip keeps role="option" on it
  // permanently (not just while its own dropdown is open), so a later
  // field's global search (no aria-controls to scope to, e.g. Degree) can
  // otherwise pick up an unrelated, already-resolved chip from an earlier
  // field as if it were one of its own options.
  async function waitForBestMatchingOption(scopeEl, desiredText, fieldLabel, excludeOptions) {
    const target = normalize(desiredText);
    if (!target) return null;

    // Confirmed via real logs: a 2-second budget here isn't always enough.
    // "Computer Science" (a common Field of Study term) rendered almost
    // instantly, but "Keshav Memorial Institute of Technology" and "MPC"
    // both hit "zero options rendered" at the old 20x100ms budget despite
    // typing/Enter working correctly (confirmed via added logging) — the
    // site's own search for less-common terms is genuinely slower, likely a
    // remote lookup rather than a local static list. 50x100ms gives that
    // room without making the common, fast case any slower (the loop still
    // breaks the instant options first appear).
    let options = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      options = deepQueryAll(scopeEl, '[role="option"]').filter(isRealOptionCandidate);
      if (excludeOptions) options = options.filter((o) => !excludeOptions.has(o));
      if (options.length > 0) break;
    }

    // These lists are often virtualized (confirmed via real HTML — a
    // react-window-style grid that only mounts the currently-visible rows)
    // — the poll above breaks as soon as it sees "some" options, which can
    // be just the first partial batch rendering in. Confirmed bug: a real
    // substring match ("Computer Science") sat a few rows further down and
    // never got considered because the search gave up right after the
    // first couple of rows appeared. A short settle delay lets the rest of
    // that initial visible batch render before matching against it.
    if (options.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      let settled = deepQueryAll(scopeEl, '[role="option"]').filter(isRealOptionCandidate);
      if (excludeOptions) settled = settled.filter((o) => !excludeOptions.has(o));
      if (settled.length >= options.length) options = settled;
    }

    if (options.length === 0) {
      console.log("[AskJobs] dropdown: zero options rendered while searching for", desiredText);
      return null;
    }

    const heuristicMatch =
      options.find((o) => normalize(o.textContent) === target) ||
      options.find((o) => normalize(o.textContent).includes(target) || target.includes(normalize(o.textContent))) ||
      options.find((o) => comboboxTextsMatch(o.textContent, target)) ||
      options.find((o) => degreeSynonymsMatch(o.textContent, target));
    if (heuristicMatch) return heuristicMatch;

    console.log("[AskJobs] dropdown: no heuristic match among", options.length, "option(s) for", desiredText, "— asking AI");
    const optionTexts = options.map((o) => o.textContent.trim());
    const aiPick = await aiPickBestOption(fieldLabel, desiredText, optionTexts);
    if (!aiPick) return null;

    return options.find((o) => o.textContent.trim() === aiPick) || null;
  }

  // Opens a custom dropdown purely to read its real option texts (not to
  // pick one), then closes it again via a SECOND click on the same trigger
  // — a targeted, in-widget toggle, not a foreign Escape/click-outside
  // signal. That distinction matters: closeAnyOpenPopup above documents in
  // detail why synthesizing Escape or a body click to dismiss a leftover
  // dropdown ended up closing an entire "Apply for this job" modal on
  // Greenhouse instead — a second click on the exact element that opened
  // the popup doesn't bubble to an ancestor's dismiss-on-outside-click
  // listener the way those did. Used so the AI-fill flow can hand a
  // dropdown's ACTUAL choices to the AI up front, instead of letting it
  // guess blind and only checking the guess against real options as a
  // fallback once Insert is clicked.
  async function gatherComboboxOptions(button) {
    const existingOptions = new Set(deepQueryAll(null, '[role="option"]'));
    clickComboboxTrigger(button);

    const controlsId = button.getAttribute("aria-controls");
    const scope = (controlsId && document.getElementById(controlsId)) || document;

    let options = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      options = deepQueryAll(scope, '[role="option"]').filter(isRealOptionCandidate);
      options = options.filter((o) => !existingOptions.has(o));
      if (options.length > 0) break;
    }
    if (options.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const settled = deepQueryAll(scope, '[role="option"]')
        .filter(isRealOptionCandidate)
        .filter((o) => !existingOptions.has(o));
      if (settled.length >= options.length) options = settled;
    }

    const texts = [...new Set(options.map((o) => o.textContent.trim()).filter(Boolean))];
    clickComboboxTrigger(button); // toggle closed again via the same trigger
    console.log(
      "[AskJobs] gathered", texts.length, "real option(s) for combobox:",
      labelForField(button) || button.getAttribute("aria-label") || button.id
    );
    if (texts.length === 0) {
      console.log("[AskJobs] combobox rendered zero role=\"option\" elements on open — this widget may use a different markup shape our scanner doesn't recognize yet");
    }
    return texts;
  }

  // Custom combobox widgets (Workday's "Select One" pattern — a <button
  // aria-haspopup="listbox"> that opens a popup list on click, confirmed via
  // real HTML: not a native <select>, so there's no value/event API for it).
  // Filling one means opening it, waiting for its options to render
  // asynchronously, and clicking the one whose text matches — this same
  // widget shape covers Degree here and was already flagged earlier for
  // custom Yes/No questions and Prefix/Gender fields, so it's built once,
  // generically, rather than one-off per field.
  async function fillCustomCombobox(button, desiredText, fieldLabel) {
    closeAnyOpenPopup();
    const existingOptions = new Set(deepQueryAll(null, '[role="option"]'));
    clickComboboxTrigger(button);

    // Confirmed real (a react-select country picker — ~195 entries):
    // opening the popup with an empty search only renders a partial/first
    // batch of options (virtualized or otherwise capped), so a target deep
    // in the alphabet ("India") never appears no matter how long
    // waitForBestMatchingOption polls — there's simply nothing more to
    // find. Typing the target into the trigger (when it IS the actual
    // search input, not a plain non-typeable button) makes the widget
    // filter its OWN list down to matching entries, which is what actually
    // surfaces it. typeStringInto (not typeCharacterByCharacter) is used
    // deliberately: the latter blurs the field when done, which would
    // close this popup before a match can be read/clicked.
    if (button.tagName === "INPUT" && desiredText) {
      typeStringInto(button, desiredText);
    }

    const controlsId = button.getAttribute("aria-controls");
    const scope = (controlsId && document.getElementById(controlsId)) || document;
    const match = await waitForBestMatchingOption(scope, desiredText, fieldLabel, existingOptions);

    if (!match) {
      console.log("[AskJobs] combobox: no matching option found (checked existing + AI fallback) for target:", desiredText, "->", fieldLabel);
      closeComboboxPopup(button);
      return false;
    }

    console.log("[AskJobs] combobox picking option:", match.textContent?.trim(), "for target:", desiredText, "->", fieldLabel);
    clickMatchedOption(match);
    await new Promise((resolve) => setTimeout(resolve, 150));
    return true;
  }

  // Wraps fillCustomCombobox with a second attempt using each individually
  // split part of a compound stored value ("Straight/Heterosexual",
  // "Hispanic or Latino") when the full string verbatim finds nothing.
  // Confirmed real: typing a slash-joined EEO value into a live-filtering
  // combobox's search returned zero rendered options at all (the widget's
  // real options are worded as single simple terms, e.g. just "Straight"),
  // leaving nothing for waitForBestMatchingOption to even compare against.
  // The full value is still tried first and used whenever it actually works
  // — splitting is only a fallback, never the first attempt.
  async function fillCustomComboboxBestEffort(button, desiredText, fieldLabel) {
    if (await fillCustomCombobox(button, desiredText, fieldLabel)) return { filled: true, value: desiredText };

    const parts = desiredText.split(/\s*(?:\/|,|\bor\b)\s*/i).map((p) => p.trim()).filter(Boolean);
    if (parts.length <= 1) return { filled: false, value: desiredText };

    for (const part of parts) {
      if (await fillCustomCombobox(button, part, fieldLabel)) return { filled: true, value: part };
    }
    return { filled: false, value: desiredText };
  }

  // Workday's live-search often narrows to ZERO results against a long,
  // oddly-punctuated resume-parsed phrase ("Computer Science (Artificial
  // Intelligence & Machine Learning)") — confirmed: typing the full string
  // returned no options at all. A short prefix (first couple of words, cut
  // at the first comma/parenthesis) reliably returns a broad candidate set
  // that the matching step can then choose from. The full text is still
  // used as the match TARGET, only the typed search term is shortened.
  function searchPrefixFor(text) {
    const cut = text.search(/[(,]/);
    const base = (cut > 0 ? text.slice(0, cut) : text).trim();
    const words = base.split(/\s+/).filter(Boolean);
    return words.slice(0, 2).join(" ") || text;
  }

  const OTHER_OPTION_PATTERNS = ["other", "others", "not listed", "none of the above"];

  // Institution names especially are often just not in a site's curated
  // list (a smaller/regional college the ATS's own database doesn't have)
  // — rather than leave the field empty, look for a generic "Other/Others"
  // catch-all option and select that instead of nothing. Opt-in per caller
  // (institution only) — picking "Other" wouldn't make sense for Field of
  // Study or Skills.
  async function trySelectOtherOption(searchInput, excludeOptions) {
    closeAnyOpenPopup();
    typeStringInto(searchInput, "Other");
    await new Promise((resolve) => setTimeout(resolve, 350));
    const alreadyOpen = deepQueryAll(null, '[role="option"]')
      .filter((o) => !excludeOptions?.has(o))
      .some(isRealOptionCandidate);
    if (!alreadyOpen) dispatchEnterKey(searchInput);

    let options = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      options = deepQueryAll(null, '[role="option"]').filter(isRealOptionCandidate);
      if (excludeOptions) options = options.filter((o) => !excludeOptions.has(o));
      if (options.length > 0) break;
    }

    const match = options.find((o) => OTHER_OPTION_PATTERNS.some((p) => matchesWholeWord(normalize(o.textContent), p)));
    if (!match) closeAnyOpenPopup();
    return match || null;
  }

  // Workday's "multiselect" search widget (School, Field of Study, Skills):
  // typing into its search box triggers a live-search dropdown of
  // role="option" checkbox items — plain setNativeValue only opens that
  // dropdown, it never actually selects anything, so the field silently
  // reverts to empty. Filling one means typing to trigger the search,
  // waiting for results, then clicking the best match — once per desired
  // value, so it doubles as the multi-value (skills) case.
  async function fillMultiselectSearch(searchInput, desiredTexts, fieldLabel, { fallbackToOther = false } = {}) {
    let filledAny = false;
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(searchInput), "value");

    for (const text of desiredTexts) {
      if (!text) continue;

      closeAnyOpenPopup();
      // Snapshot BEFORE typing — excludes any already-selected chip from an
      // earlier term/field (which keeps role="option" on it permanently,
      // not just while its own dropdown is open) from being picked up as if
      // it were one of THIS search's results.
      const existingOptions = new Set(deepQueryAll(null, '[role="option"]'));
      const typedPrefix = searchPrefixFor(text);
      typeStringInto(searchInput, typedPrefix);
      console.log("[AskJobs] multiselect: typed", JSON.stringify(typedPrefix), "into search box for", fieldLabel, "— input.value is now", JSON.stringify(searchInput.value));

      // Some of these widgets (confirmed: Workday's Skills field, per its
      // real HTML) only run their search once Enter is pressed — plain
      // typing alone never triggers it, which is why this reported "zero
      // options rendered" earlier despite the field visibly working when a
      // human typed the same text. Others (confirmed: School, Field of
      // Study) already live-search as you type. Only send Enter if nothing
      // has rendered yet, so an already-open live-search result list can't
      // get its top item accidentally committed by an unnecessary Enter.
      await new Promise((resolve) => setTimeout(resolve, 350));
      const alreadyOpen = deepQueryAll(null, '[role="option"]')
        .filter((o) => !existingOptions.has(o))
        .some(isRealOptionCandidate);
      console.log("[AskJobs] multiselect:", fieldLabel, "— alreadyOpen after 350ms:", alreadyOpen, "; dispatching Enter:", !alreadyOpen);
      if (!alreadyOpen) dispatchEnterKey(searchInput);

      let match = await waitForBestMatchingOption(null, text, fieldLabel, existingOptions);

      if (!match && fallbackToOther) {
        match = await trySelectOtherOption(searchInput, existingOptions);
        if (match) console.log("[AskJobs] multiselect falling back to 'Other' option for:", text);
      }

      if (match) {
        clickMatchedOption(match);
        filledAny = true;
        console.log("[AskJobs] multiselect matched:", text, "->", match.textContent?.trim());
        await new Promise((resolve) => setTimeout(resolve, 200));
      } else {
        console.log("[AskJobs] multiselect no match found for:", text);
        closeAnyOpenPopup();
      }

      // Clear the search box before the next term — most of these widgets
      // reset it themselves after a selection, clear defensively in case
      // this one doesn't (and to discard an unmatched leftover search too).
      if (searchInput.value) {
        descriptor.set.call(searchInput, "");
        searchInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      }
    }

    closeAnyOpenPopup();

    searchInput.blur();
    searchInput.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
    return filledAny;
  }

  function isMultiselectSearchBox(field) {
    return (
      field.getAttribute("data-automation-id") === "searchBox" ||
      !!field.closest('[data-uxi-widget-type="multiselect"]')
    );
  }

  // Same recognize-and-fill flow as fillStructuredSection's plain-field
  // loop, applied to combobox trigger buttons instead of input/select/
  // textarea elements.
  async function fillStructuredComboboxes(container, matchers, entryData) {
    const buttons = container.querySelectorAll('button[aria-haspopup="listbox"]');
    for (const button of buttons) {
      if (button.disabled) continue;
      const fieldLabel = labelForField(button) || button.getAttribute("aria-label") || button.name || button.id;
      const currentText = normalize(visibleText(button) || "");
      // Already has a real selection (not the placeholder) — leave it alone.
      if (currentText && !PLACEHOLDER_OPTION_TEXT.test(currentText)) continue;

      const signature = fieldSignature(button);
      if (attemptedSignatures.has(signature)) continue;

      const key = classifyStructured(button, matchers);
      if (!key) {
        console.log("[AskJobs] combobox not recognized:", fieldLabel);
        recordResult("skipped", fieldLabel, "Not recognized as a known field");
        continue;
      }

      const value = entryData[key];
      if (value === undefined || value === null || value === "") {
        console.log("[AskJobs] combobox recognized as", key, "but no data for it:", fieldLabel);
        recordResult("skipped", fieldLabel, `Recognized as "${key}" but no data on file`);
        continue;
      }

      attemptedSignatures.add(signature);
      const filled = await fillCustomCombobox(button, String(value), fieldLabel);
      recordResult(filled ? "filled" : "skipped", fieldLabel, filled ? String(value) : `Couldn't find a matching option for "${value}"`);
      console.log("[AskJobs] combobox", filled ? "filled" : "fill failed", ":", key, "=", value, "->", fieldLabel);
    }
  }

  // Fills only the fields it both recognizes AND has real data for.
  // Recognized-but-no-data fields (e.g. education has no startDate/endDate
  // in our schema, only graduationYear) are left untouched — not marked
  // attempted — so they remain visible to the classify-fields/AI-fill
  // fallbacks instead of being silently locked out.
  async function fillStructuredSection(container, matchers, entryData) {
    if (!container || !entryData) return;
    const fields = container.querySelectorAll("input, select, textarea");
    console.log("[AskJobs] structured section: scanning", fields.length, "field(s) with entry data", entryData);

    for (const field of fields) {
      // placeholder sits before the final "Unlabeled field" fallback, not
    // before name/id/aria-label — those are still stronger signals when
    // present, but a field with none of them (confirmed real on Breezy:
    // Company/Title carry only a placeholder, no name/id/label at all)
    // shouldn't show as generic "Unlabeled field" in the sidebar when the
    // placeholder text is right there and already used to classify it.
    const fieldLabel = labelForField(field) || field.getAttribute("aria-label") || field.name || field.id || field.getAttribute("placeholder") || "Unlabeled field";
      if (field.disabled || field.type === "hidden" || field.value) continue;
      const signature = fieldSignature(field);
      if (attemptedSignatures.has(signature)) continue;

      if (field.type === "checkbox") {
        const label = normalize(labelForField(field) || field.getAttribute("aria-label") || "");
        if (entryData.current && CURRENT_POSITION_PATTERNS.some((p) => matchesWholeWord(label, p))) {
          attemptedSignatures.add(signature);
          setNativeChecked(field);
          recordResult("filled", fieldLabel, "Checked (current position)");
        }
        continue;
      }

      const key = classifyStructured(field, matchers);
      if (!key) {
        console.log("[AskJobs] structured field not recognized:", fieldLabel);
        recordResult("skipped", fieldLabel, "Not recognized as a known field");
        continue;
      }
      // Leave a still-current entry's end date alone rather than guessing.
      if (key === "endDate" && entryData.current) continue;

      const value = entryData[key];
      if (value === undefined || value === null || value === "") {
        console.log("[AskJobs] structured field recognized as", key, "but no data for it:", fieldLabel);
        recordResult("skipped", fieldLabel, `Recognized as "${key}" but no data on file`);
        continue;
      }

      if (await fillStructuredField(field, value, fieldLabel, key)) {
        attemptedSignatures.add(signature);
        recordResult("filled", fieldLabel, String(value));
        console.log("[AskJobs] structured field filled:", key, "=", value, "->", fieldLabel);
      } else {
        recordResult("skipped", fieldLabel, `Couldn't fill with "${value}"`);
        console.log("[AskJobs] structured field fill failed:", key, "=", value, "->", fieldLabel);
      }
    }

    await fillStructuredComboboxes(container, matchers, entryData);
  }

  // Some ATS forms (Workday included) render zero entry fields for Work
  // Experience — only an "Add" button — until it's clicked once. Clicked at
  // most once, scoped to inside this section's own container so it can
  // never hit an unrelated "Add" button elsewhere on the page.
  async function revealFirstEntryIfNeeded(container) {
    if (!container) return;
    const hasFields = container.querySelector("input:not([type=hidden]), select, textarea");
    if (hasFields) return;

    const addButton = Array.from(container.querySelectorAll("button, a, [role='button']")).find((el) =>
      /\badd\b/i.test((el.textContent || "").trim())
    );
    if (!addButton) {
      console.log("[AskJobs] revealFirstEntryIfNeeded: no 'Add' button found inside the matched section container — it may live outside it", container);
      return;
    }

    addButton.click();

    // Poll rather than a single fixed wait — confirmed necessary: the
    // Websites section took longer than the old fixed 300ms to actually
    // render its revealed field, silently leaving that entry's fill pass
    // with zero fields to work with (logged as "scanning 0 field(s)").
    // Other sections render faster, so this exits as soon as fields show
    // up rather than always waiting the full 2s.
    let revealed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (container.querySelector("input:not([type=hidden]), select, textarea")) {
        revealed = true;
        break;
      }
    }
    if (!revealed) {
      console.log("[AskJobs] revealFirstEntryIfNeeded: clicked 'Add' but no fields appeared within 2s", container);
    }
  }

  // Fills every entry in a profile array (education/experience), clicking
  // an "Add"/"Add Another" button — scoped to this section's own container —
  // once per additional entry beyond the first. Self-limiting: only clicks
  // as many times as there are real entries to fill, and stops (rather than
  // guessing) the moment no such button can be found.
  //
  // Each entry's fill is scoped to its own numbered sub-panel when the site
  // nests entries that way (confirmed on Workday: a role="group" per entry,
  // direct children of the section) — confirmed necessary: without this,
  // a still-empty field from an EARLIER entry (its fill having failed) gets
  // reprocessed with a LATER entry's data on the next pass, since scanning
  // the whole section container can't otherwise tell which entry a field
  // belongs to. Falls back to the whole container if the site doesn't nest
  // entries this way.
  async function fillRepeatedEntries(container, matchers, entries, sectionLabel) {
    if (!container || !entries?.length) return;

    for (let i = 0; i < entries.length; i++) {
      if (i > 0) {
        // Same broader selector as revealFirstEntryIfNeeded — an "Add"
        // control is just as often an <a>/[role='button'] as a real
        // <button> (confirmed real on Breezy: "Add Education"/"Add
        // Position" are both plain <a> links), and this search was missing
        // that, silently stopping after the first entry on any such site.
        const addButton = Array.from(container.querySelectorAll("button, a, [role='button']")).find((el) =>
          /\badd\b/i.test((el.textContent || "").trim())
        );
        if (!addButton) {
          console.log(`[AskJobs] ${sectionLabel}: no 'Add' button found for entry ${i + 1} of ${entries.length} — stopping`);
          break;
        }
        addButton.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      let entryContainers = Array.from(container.querySelectorAll(':scope > [role="group"]'));
      if (entryContainers.length === 0) {
        // Breezy-style repeated entries: <ul><li ng-repeat="...">...</li></ul>,
        // no [role="group"] wrapper at all. Falling through to the shared
        // container for every entry index re-scanned ALL entries built so
        // far on every subsequent entry's fill pass — confirmed real:
        // Education's scanned field count grew from 11 to 16 between entry
        // 1 and entry 2, because entry 2's pass re-scanned entry 1's still-
        // unfilled fields against entry 2's data too. A <li> is this site's
        // real per-entry boundary, same role [role="group"] plays elsewhere.
        entryContainers = Array.from(container.querySelectorAll("li"));
      }
      const entryContainer = entryContainers[i] || container;
      await fillStructuredSection(entryContainer, matchers, entries[i]);
    }
  }

  async function fillEducationAndExperience() {
    console.log("[AskJobs] education entries:", profile?.education?.length || 0, "experience entries:", profile?.experience?.length || 0);

    if (profile?.education?.length) {
      const container = findSectionContainer("education");
      console.log("[AskJobs] education section container found?", !!container, container);
      await revealFirstEntryIfNeeded(container);
      await fillRepeatedEntries(container, EDUCATION_FIELD_MATCHERS, profile.education, "education");
    }
    if (profile?.experience?.length) {
      const container = findSectionContainer("experience");
      console.log("[AskJobs] experience section container found?", !!container, container);
      await revealFirstEntryIfNeeded(container);
      await fillRepeatedEntries(container, EXPERIENCE_FIELD_MATCHERS, profile.experience, "experience");
    }
  }

  async function fillCertifications() {
    if (!profile?.certifications?.length) return;
    const container = findSectionContainer("certifications");
    console.log("[AskJobs] certifications section container found?", !!container, container);
    await revealFirstEntryIfNeeded(container);
    await fillRepeatedEntries(container, CERTIFICATION_FIELD_MATCHERS, profile.certifications, "certifications");
  }

  async function fillWebsites() {
    // Populated by adaptCandidateProfile() from linkedinUrl/githubUrl/
    // portfolioUrl — our flat Candidate schema, unlike OG's personalInfo.websites array.
    const websites = profile?.websites || [];
    if (!websites.length) return;
    const container = findSectionContainer("websites");
    console.log("[AskJobs] websites section container found?", !!container, container);
    await revealFirstEntryIfNeeded(container);
    const entries = websites.map((url) => ({ url }));
    await fillRepeatedEntries(container, WEBSITE_FIELD_MATCHERS, entries, "websites");
  }

  const attemptedRadioGroups = new Set();

  // Same classification-queue idea as maybeQueueFieldForClassification, for
  // radio-button groups whose question text didn't match RADIO_MATCHERS.
  function maybeQueueRadioGroupForClassification(name, radios, rawQuestionText) {
    if (queuedRadioGroupNames.has(name)) return;
    const label = (rawQuestionText || "").trim();
    if (label.length < 10 || label.length > MAX_QUESTION_LABEL_LENGTH) return;

    queuedRadioGroupNames.add(name);
    const options = radios.map((r) => (labelForField(r) || r.value || "").trim()).filter(Boolean);
    pendingClassificationItems.push({
      kind: "radioGroup",
      radios,
      questionText: label,
      fieldType: "radio",
      options,
    });
  }

  async function scanAndFillRadioGroups(root) {
    const radios = deepQueryAll(root, 'input[type="radio"]');
    if (radios.length === 0) return;

    const groups = new Map();
    for (const radio of radios) {
      if (!radio.name || radio.disabled) continue;
      if (!groups.has(radio.name)) groups.set(radio.name, []);
      groups.get(radio.name).push(radio);
    }

    for (const [name, groupRadios] of groups) {
      if (attemptedRadioGroups.has(name)) continue;
      // Already answered (by the page itself or the user) — leave it alone.
      if (groupRadios.some((r) => r.checked)) continue;

      const rawQuestionText = groupQuestionText(groupRadios);
      if (rawQuestionText.length > MAX_QUESTION_LABEL_LENGTH) {
        attemptedRadioGroups.add(name);
        continue;
      }
      const questionText = normalize(rawQuestionText);

      if (isGenderIdentityQuestion(questionText)) {
        attemptedRadioGroups.add(name);
        const optionTexts = groupRadios.map((r) => (labelForField(r) || r.value || "").trim()).filter(Boolean);
        const suggestion = await resolveOptionMatch(rawQuestionText, profile?.gender, optionTexts, bestGenderOptionText(optionTexts));
        if (suggestion) {
          renderStoredValueSuggestion(rawQuestionText, suggestion, () => {
            const target = groupRadios.find((r) => (labelForField(r) || r.value || "").trim() === suggestion);
            if (target) {
              setNativeChecked(target);
              recordResult("filled", rawQuestionText, `${suggestion} (from your profile, reviewed)`);
            }
          });
          recordResult("skipped", rawQuestionText, "Suggested from your profile — review above and click Insert");
        } else {
          recordResult("skipped", rawQuestionText, "Gender identity question — no matching option found for your stored profile value, please answer directly");
        }
        continue;
      }

      if (isDisabilityQuestion(questionText)) {
        attemptedRadioGroups.add(name);
        const optionTexts = groupRadios.map((r) => (labelForField(r) || r.value || "").trim()).filter(Boolean);
        const suggestion = await resolveOptionMatch(
          rawQuestionText,
          jobPreferences?.disabilityStatus,
          optionTexts,
          bestDisabilityOptionText(optionTexts),
        );
        if (suggestion) {
          renderStoredValueSuggestion(rawQuestionText, suggestion, () => {
            const target = groupRadios.find((r) => (labelForField(r) || r.value || "").trim() === suggestion);
            if (target) {
              setNativeChecked(target);
              recordResult("filled", rawQuestionText, `${suggestion} (from your Settings, reviewed)`);
            }
          });
          recordResult("skipped", rawQuestionText, "Suggested from your Settings — review above and click Insert");
        } else {
          recordResult("skipped", rawQuestionText, "Voluntary demographic question — set a disability status in Settings to get a suggestion, or answer directly");
        }
        continue;
      }

      if (isSensitiveSelfIdQuestion(questionText)) {
        attemptedRadioGroups.add(name);
        const label = rawQuestionText || "Demographic question";
        const stored = sensitiveSelfIdSingleValue(questionText);
        const optionTexts = stored ? groupRadios.map((r) => (labelForField(r) || r.value || "").trim()).filter(Boolean) : [];
        const normStored = stored ? normalize(stored) : "";
        const quickMatch = stored
          ? optionTexts.find((t) => normalize(t).includes(normStored) || normStored.includes(normalize(t)))
          : null;
        const matchedOption = await resolveOptionMatch(label, stored, optionTexts, quickMatch);
        if (matchedOption) {
          renderStoredValueSuggestion(label, matchedOption, () => {
            const target = groupRadios.find((r) => (labelForField(r) || r.value || "").trim() === matchedOption);
            if (target) {
              setNativeChecked(target);
              recordResult("filled", label, `${matchedOption} (from the candidate's EEO profile, reviewed)`);
            }
          });
          recordResult("skipped", label, "Suggested from the candidate's EEO profile — review above and click Insert");
        } else {
          recordResult("skipped", label, "Voluntary demographic question — left for you to answer directly");
        }
        continue;
      }

      const matcher = matchRadioQuestion(questionText);
      if (!matcher) {
        maybeQueueRadioGroupForClassification(name, groupRadios, rawQuestionText);
        continue; // Not a question we recognize — leave for the AI classification fallback or the user.
      }

      const answer = radioAnswerForKey(matcher.key);
      if (answer === null) {
        recordResult("skipped", rawQuestionText || matcher.key, "Recognized, but no stored preference set yet");
        continue; // Recognized, but no stored preference to answer with yet.
      }

      const wantedText = answer ? "yes" : "no";
      const target = groupRadios.find((r) => {
        const label = normalize(labelForField(r) || r.value || "");
        return label === wantedText || label.startsWith(wantedText);
      });

      attemptedRadioGroups.add(name);
      if (target) {
        setNativeChecked(target);
        recordResult("filled", rawQuestionText || matcher.key, wantedText === "yes" ? "Yes" : "No");
      } else {
        recordResult("skipped", rawQuestionText || matcher.key, "Couldn't find a matching Yes/No option");
      }
    }
  }

  // Same screening questions RADIO_MATCHERS already recognizes (work
  // authorization, relocation, worked-here-before, etc.), but rendered as a
  // standalone "Select One" combobox button (aria-haspopup="listbox")
  // instead of native <input type="radio"> elements — confirmed real:
  // "Are you willing to relocate if required by the position?" showed up
  // this way and scanAndFillRadioGroups (native-radio-only) never even saw
  // it. Scans the WHOLE page, not scoped to Education/Experience like
  // fillStructuredComboboxes — these are standalone application-level
  // questions, not part of any repeated entry.
  async function scanAndFillGenericComboboxes(root) {
    // Confirmed real: Darwinbox's "Choices.js"-style combobox isn't a
    // <button> at all — it's a <div role="combobox" aria-haspopup="true">
    // inside a shadow root — so the selector also matches any
    // role="combobox" element generically, not just Workday's button
    // shape.
    const buttons = deepQueryAll(root, 'button[aria-haspopup="listbox"], [role="combobox"]');
    console.log("[AskJobs] generic comboboxes: found", buttons.length, "button(s) on this page");

    for (const button of buttons) {
      const fieldLabel = labelForField(button) || button.getAttribute("aria-label") || button.name || button.id || "Unlabeled field";

      // Confirmed real (Ashby's RevenueCat GDPR consent checkbox): its real
      // label ("I acknowledge the GDPR Candidate Privacy Notice") shares a
      // container with the entire multi-thousand-word notice body that
      // follows it, and label resolution swept up both. That's not just a
      // display problem — the resulting "label" gets tested against every
      // category below (gender/disability/sensitive/screening), and a huge
      // block of legal text is disturbingly likely to contain a stray
      // keyword match (this one hit "disability" mid-sentence in an
      // unrelated clause and got wrongly answered as a disability
      // question). Bail out before any of that testing happens, not just
      // before queueing for AI — a real question is never this long.
      if (fieldLabel.length > MAX_QUESTION_LABEL_LENGTH) {
        console.log("[AskJobs] generic combobox skipped — label suspiciously long (", fieldLabel.length, "chars), likely an over-broad container match, not a real question");
        continue;
      }

      if (button.disabled) {
        console.log("[AskJobs] generic combobox skipped (disabled):", fieldLabel);
        continue;
      }
      const signature = fieldSignature(button);
      if (attemptedSignatures.has(signature)) {
        console.log("[AskJobs] generic combobox skipped (already attempted):", fieldLabel);
        continue;
      }

      const currentText = normalize(visibleText(button) || "");
      if (currentText && !PLACEHOLDER_OPTION_TEXT.test(currentText)) {
        console.log("[AskJobs] generic combobox skipped (already answered):", fieldLabel, "->", currentText);
        continue; // already answered
      }

      const questionText = normalize(fieldLabel);

      if (isGenderIdentityQuestion(questionText)) {
        attemptedSignatures.add(signature);
        const stored = profile?.gender;
        console.log("[AskJobs] generic combobox recognized as gender identity, stored value:", stored, "->", fieldLabel);
        if (stored) {
          // The real options only render once the popup opens (unlike a
          // native <select>), so there's nothing to match against yet —
          // hand the raw stored value to fillCustomCombobox at Insert
          // time, same as the AI-answered combobox path does, and let it
          // match against whatever actually appears when opened.
          renderStoredValueSuggestion(fieldLabel, stored, async () => {
            const result = await fillCustomComboboxBestEffort(button, stored, fieldLabel);
            recordResult(result.filled ? "filled" : "skipped", fieldLabel, result.filled ? `${result.value} (from your profile, reviewed)` : "Couldn't find a matching option");
          });
          recordResult("skipped", fieldLabel, "Suggested from your profile — review above and click Insert");
        } else {
          recordResult("skipped", fieldLabel, "Gender identity question — no gender set in your profile, please answer directly");
        }
        continue;
      }

      if (isDisabilityQuestion(questionText)) {
        attemptedSignatures.add(signature);
        const stored = jobPreferences?.disabilityStatus;
        console.log("[AskJobs] generic combobox recognized as disability status, stored value:", stored, "->", fieldLabel);
        if (stored) {
          renderStoredValueSuggestion(fieldLabel, stored, async () => {
            const result = await fillCustomComboboxBestEffort(button, stored, fieldLabel);
            recordResult(result.filled ? "filled" : "skipped", fieldLabel, result.filled ? `${result.value} (from your Settings, reviewed)` : "Couldn't find a matching option");
          });
          recordResult("skipped", fieldLabel, "Suggested from your Settings — review above and click Insert");
        } else {
          recordResult("skipped", fieldLabel, "Voluntary demographic question — set a disability status in Settings to get a suggestion, or answer directly");
        }
        continue;
      }

      if (isCountryQuestion(questionText)) {
        attemptedSignatures.add(signature);
        const stored = profile?.address?.country;
        console.log("[AskJobs] generic combobox recognized as country, stored value:", stored, "->", fieldLabel);
        if (stored) {
          renderStoredValueSuggestion(fieldLabel, stored, async () => {
            const result = await fillCustomComboboxBestEffort(button, stored, fieldLabel);
            recordResult(result.filled ? "filled" : "skipped", fieldLabel, result.filled ? `${result.value} (from your profile, reviewed)` : "Couldn't find a matching option");
          });
          recordResult("skipped", fieldLabel, "Suggested from your profile — review above and click Insert");
        } else {
          recordResult("skipped", fieldLabel, "Recognized as a country field, but no country set in your profile — please answer directly");
        }
        continue;
      }

      if (isSensitiveSelfIdQuestion(questionText)) {
        attemptedSignatures.add(signature);
        const stored = sensitiveSelfIdSingleValue(questionText);
        console.log("[AskJobs] generic combobox recognized as sensitive self-ID question, stored value:", stored, "->", fieldLabel);
        if (stored) {
          renderStoredValueSuggestion(fieldLabel, stored, async () => {
            const result = await fillCustomComboboxBestEffort(button, stored, fieldLabel);
            recordResult(
              result.filled ? "filled" : "skipped",
              fieldLabel,
              result.filled ? `${result.value} (from the candidate's EEO profile, reviewed)` : "Couldn't find a matching option",
            );
          });
          recordResult("skipped", fieldLabel, "Suggested from the candidate's EEO profile — review above and click Insert");
        } else {
          recordResult("skipped", fieldLabel, "Voluntary demographic question — left for you to answer directly");
        }
        continue;
      }

      const matcher = matchRadioQuestion(questionText);
      if (!matcher) {
        // Not one of the fixed screening categories — queue for the broader
        // qualification-answering AI pass instead of leaving it silently
        // unanswered. Its real options only exist once opened (unlike a
        // native <select>), so gatherComboboxOptions opens it, reads them,
        // and closes it again right here — the AI gets the field's ACTUAL
        // choices up front, rather than guessing blind and only checking
        // the guess against real options as a fallback once Insert is
        // clicked (fillCustomCombobox still re-opens and matches at insert
        // time too, but now against a guess that was already constrained
        // to one of these options in the first place).
        if (queuedFieldSignatures.has(signature)) continue;
        const rawLabel = labelForField(button) || button.getAttribute("aria-label") || "";
        const rawLabelLength = rawLabel.trim().length;
        if (rawLabelLength < 10) {
          console.log("[AskJobs] generic combobox not recognized and label too short to queue:", fieldLabel);
          continue;
        }
        if (rawLabelLength > MAX_QUESTION_LABEL_LENGTH) {
          console.log("[AskJobs] generic combobox skipped — label suspiciously long (", rawLabelLength, "chars), likely an over-broad container match, not a real question:", fieldLabel);
          continue;
        }
        console.log("[AskJobs] generic combobox not recognized — queueing for AI:", fieldLabel);
        queuedFieldSignatures.add(signature);
        const options = await gatherComboboxOptions(button);
        pendingClassificationItems.push({
          kind: "combobox",
          button,
          questionText: rawLabel.trim(),
          fieldType: "combobox",
          options,
        });
        continue;
      }

      const answer = radioAnswerForKey(matcher.key);
      if (answer === null) {
        console.log("[AskJobs] generic combobox recognized as", matcher.key, "but no stored preference:", fieldLabel);
        recordResult("skipped", fieldLabel, "Recognized, but no stored preference set yet");
        continue;
      }

      attemptedSignatures.add(signature);
      const wantedText = answer ? "Yes" : "No";
      console.log("[AskJobs] generic combobox recognized as", matcher.key, "-> attempting", wantedText, "for:", fieldLabel);
      const filled = await fillCustomCombobox(button, wantedText, fieldLabel);
      console.log("[AskJobs] generic combobox", filled ? "filled" : "fill failed", ":", fieldLabel, "->", wantedText);
      recordResult(filled ? "filled" : "skipped", fieldLabel, filled ? wantedText : `Couldn't find a matching option for "${wantedText}"`);
    }
  }

  const attemptedCheckboxGroups = new Set();
  const queuedCheckboxGroupNames = new Set();

  // Finds the ancestor <fieldset> that actually holds this checkbox
  // GROUP's question text — confirmed via real HTML (Workday's "Please
  // share your shift preference" -> Night Job/Day Job/...): the individual
  // checkboxes have NO shared `name` attribute at all (unlike radio groups),
  // and the <fieldset> immediately wrapping the checkbox rows has no
  // <legend> of its own — the real question text sits in an OUTER
  // fieldset's <legend>, one level further up, wrapping both that legend
  // and the inner checkbox-rows fieldset. Walks up through nested fieldsets
  // until it finds one that actually has legend text, rather than assuming
  // exactly one level of nesting.
  function questionFieldsetFor(box) {
    let node = box.closest("fieldset");
    while (node) {
      if (node.querySelector("legend")?.textContent?.trim()) return node;
      node = node.parentElement?.closest("fieldset") || null;
    }
    return box.closest("fieldset");
  }

  // Standalone multi-option questions rendered as a GROUP of checkboxes
  // ("Please share your shift preference" -> Night Job / Day Job / Flex
  // Job / ...) rather than radios or a combobox — confirmed real: this was
  // completely invisible before, not because it was unrecognized, but
  // because fillField's generic per-field loop bailed out on every
  // checkbox before ever reaching classification (see the field.type
  // checkbox/radio skip above). A lone checkbox (e.g. Education's "I
  // currently work here") isn't a grouped question and is left to its own
  // existing handling — only fieldsets containing 2+ checkboxes land here.
  async function scanAndFillCheckboxGroups(root) {
    const boxes = deepQueryAll(root, 'input[type="checkbox"]');
    if (boxes.length === 0) return;

    const groups = new Map();
    for (const box of boxes) {
      if (box.disabled) continue;
      const fieldsetEl = questionFieldsetFor(box);
      if (!fieldsetEl) continue;
      if (!groups.has(fieldsetEl)) groups.set(fieldsetEl, []);
      groups.get(fieldsetEl).push(box);
    }

    for (const [fieldsetEl, groupBoxes] of groups) {
      if (groupBoxes.length < 2) continue;

      const legend = fieldsetEl.querySelector("legend");
      const rawQuestionText = (legend?.textContent || "").trim();
      // Stable per-question key: the legend's own id if it (or a child) has
      // one (Workday: "checkbox-group-label7"), falling back to the first
      // checkbox's id — DOM elements themselves aren't reused as Set keys
      // here since a re-scan after a step change queries fresh nodes.
      const name = legend?.querySelector("[id]")?.id || legend?.id || groupBoxes[0].id;
      if (!name) continue;

      if (attemptedCheckboxGroups.has(name)) continue;
      if (groupBoxes.some((b) => b.checked)) continue; // already answered

      const questionText = normalize(rawQuestionText);

      if (isSensitiveSelfIdQuestion(questionText)) {
        attemptedCheckboxGroups.add(name);
        const label = rawQuestionText || "Demographic question";
        const suggestion = sensitiveSelfIdCheckboxTargets(questionText, groupBoxes);
        if (suggestion) {
          renderStoredValueSuggestion(label, suggestion.displayText, () => {
            suggestion.targets.forEach((box) => setNativeChecked(box));
            recordResult("filled", label, `${suggestion.displayText} (from the candidate's EEO profile, reviewed)`);
          });
          recordResult("skipped", label, "Suggested from the candidate's EEO profile — review above and click Insert");
        } else {
          recordResult("skipped", label, "Voluntary demographic question — left for you to answer directly");
        }
        continue;
      }

      const matcher = matchRadioQuestion(questionText);

      if (!matcher) {
        if (queuedCheckboxGroupNames.has(name)) continue;
        const label = rawQuestionText;
        if (label.length < 10 || label.length > MAX_QUESTION_LABEL_LENGTH) continue;
        queuedCheckboxGroupNames.add(name);
        const options = groupBoxes.map((b) => (labelForField(b) || b.value || "").trim()).filter(Boolean);
        pendingClassificationItems.push({
          kind: "checkboxGroup",
          boxes: groupBoxes,
          questionText: label,
          fieldType: "checkbox",
          options,
        });
        continue; // Not one of the fixed screening categories — leave for the AI qualification-answer fallback.
      }

      const answer = radioAnswerForKey(matcher.key);
      if (answer === null) {
        recordResult("skipped", rawQuestionText || matcher.key, "Recognized, but no stored preference set yet");
        continue;
      }

      const wantedText = answer ? "yes" : "no";
      const target = groupBoxes.find((b) => {
        const label = normalize(labelForField(b) || b.value || "");
        return label === wantedText || label.startsWith(wantedText);
      });

      attemptedCheckboxGroups.add(name);
      if (target) {
        setNativeChecked(target);
        recordResult("filled", rawQuestionText || matcher.key, wantedText === "yes" ? "Yes" : "No");
      } else {
        recordResult("skipped", rawQuestionText || matcher.key, "Couldn't find a matching Yes/No option");
      }
    }
  }

  const BUTTON_TOGGLE_ANSWER_WORDS = new Set(["yes", "no"]);
  const attemptedButtonToggleGroupParents = new WeakSet();
  const queuedButtonToggleGroupParents = new WeakSet();

  // Resolves the overall question for a group of plain <button> "pill"
  // toggles the same general way groupQuestionText does for real radios:
  // strip every button's own visible text out of the smallest container
  // holding all of them, escalating outward up to 3 levels if that's still
  // too short to be a real question. Buttons don't have the label-for/value
  // association radios do, so this uses each button's raw textContent
  // directly rather than labelForField/.value.
  function buttonToggleGroupQuestionText(buttons) {
    const optionTexts = buttons.map((b) => normalize(b.textContent || ""));
    function strippedText(container) {
      if (!container) return "";
      let text = normalize(container.textContent || "");
      for (const opt of optionTexts) {
        if (opt) text = text.replace(opt, "");
      }
      return text.trim();
    }

    let container = buttons[0].parentElement;
    while (container && !buttons.every((b) => container.contains(b))) {
      container = container.parentElement;
    }
    let text = strippedText(container);
    if (text.length >= 10) return text;

    let outer = container?.parentElement;
    for (let i = 0; i < 3 && outer; i++) {
      text = strippedText(outer);
      if (text.length >= 10) return text;
      outer = outer.parentElement;
    }
    return text;
  }

  // Confirmed real (Ashby): "Do you have 3+ years of experience...?" and
  // several other screening questions render as a row of plain <button>
  // "pills" (Yes/No) with no radio/combobox semantics at all — not
  // input[type=radio], not [role=combobox], not
  // button[aria-haspopup=listbox]. These were entirely invisible to every
  // scanner above: never filled, never even flagged as "need attention",
  // since nothing was looking at them. Rather than add yet another
  // site-specific scanner keyed to Ashby's own markup (which is what every
  // fix so far in this file has amounted to, one ATS at a time), this is
  // deliberately behavior-based instead of markup-based: it looks for ANY
  // 2+ sibling <button>s whose OWN visible text is exactly a known short
  // answer word, which should generalize to other sites using the same
  // pill-button pattern without needing their HTML first.
  //
  // Kept deliberately narrow for safety: only "yes"/"no" text qualifies a
  // button as a candidate at all. A real Submit/Next/Continue/Save button's
  // text is essentially never exactly "Yes" or "No", so the risk of ever
  // clicking a real action button by mistake is very low — a much stronger
  // guarantee than trying to maintain a blocklist of action-button phrases,
  // which would always be one unseen ATS away from missing something.
  async function scanAndFillButtonToggleGroups(root) {
    const candidates = deepQueryAll(root, "button").filter((b) => {
      if (b.disabled) return false;
      return BUTTON_TOGGLE_ANSWER_WORDS.has(normalize(b.textContent || ""));
    });
    if (candidates.length === 0) return;

    // Group by shared parent — two separate Yes/No questions elsewhere on
    // the same page must not get merged into one group.
    const groups = new Map();
    for (const button of candidates) {
      const parent = button.parentElement;
      if (!parent) continue;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(button);
    }

    for (const [parent, groupButtons] of groups) {
      if (groupButtons.length < 2) continue;
      if (attemptedButtonToggleGroupParents.has(parent)) continue;

      // Most of these toggle widgets mark the selected button with
      // aria-pressed="true"; checking that covers the accessible case. A
      // visually-selected-only widget with no ARIA state at all can't be
      // detected this way, but re-clicking an already-selected Yes/No
      // toggle is harmless (confirmed a no-op on every real example seen).
      if (groupButtons.some((b) => b.getAttribute("aria-pressed") === "true")) {
        attemptedButtonToggleGroupParents.add(parent);
        continue;
      }

      const rawQuestionText = buttonToggleGroupQuestionText(groupButtons);
      if (rawQuestionText.length < 10 || rawQuestionText.length > MAX_QUESTION_LABEL_LENGTH) continue;
      const questionText = normalize(rawQuestionText);

      if (
        isGenderIdentityQuestion(questionText) ||
        isDisabilityQuestion(questionText) ||
        isSensitiveSelfIdQuestion(questionText)
      ) {
        attemptedButtonToggleGroupParents.add(parent);
        recordResult("skipped", rawQuestionText, "Voluntary demographic question — left for you to answer directly");
        continue;
      }

      const matcher = matchRadioQuestion(questionText);
      if (!matcher) {
        // Not one of the fixed screening categories — same AI classification
        // queue every other unrecognized widget shape feeds into.
        if (queuedButtonToggleGroupParents.has(parent)) continue;
        queuedButtonToggleGroupParents.add(parent);
        const options = groupButtons.map((b) => normalize(b.textContent || "")).filter(Boolean);
        pendingClassificationItems.push({
          kind: "buttonToggleGroup",
          buttons: groupButtons,
          questionText: rawQuestionText,
          fieldType: "button",
          options,
        });
        continue;
      }

      const answer = radioAnswerForKey(matcher.key);
      if (answer === null) {
        recordResult("skipped", rawQuestionText, "Recognized, but no stored preference set yet");
        continue;
      }

      attemptedButtonToggleGroupParents.add(parent);
      const wantedWord = answer ? "yes" : "no";
      const target = groupButtons.find((b) => normalize(b.textContent || "") === wantedWord);
      if (target) {
        target.click();
        recordResult("filled", rawQuestionText, answer ? "Yes" : "No");
      } else {
        recordResult("skipped", rawQuestionText, `Couldn't find a matching option for "${answer ? "Yes" : "No"}"`);
      }
    }
  }

  function updateSidebarCounter() {
    if (!sidebarShadow) return;
    const counter = sidebarShadow.querySelector("#askjobs-counter");
    if (counter) {
      counter.textContent = skippedCount
        ? `${filledCount} filled, ${skippedCount} need attention`
        : `${filledCount} filled`;
      counter.classList.toggle("attention", skippedCount > 0);
    }
  }

  // Renders the full field-by-field trace in the sidebar itself — built
  // with textContent, not innerHTML, since labels come from the page's own
  // (untrusted) DOM text. Re-renders the whole list each call; the list
  // stays small enough (a few dozen fields per application) for this to be
  // cheap, and it's simpler than diffing.
  function renderFieldResults() {
    const container = sidebarShadow?.querySelector("#askjobs-field-results");
    if (!container) return;
    container.innerHTML = "";

    for (const result of fieldResults) {
      const row = document.createElement("div");
      row.className = "field-row";

      const icon = document.createElement("span");
      icon.className = `field-icon ${result.status === "filled" ? "icon-filled" : "icon-skipped"}`;
      icon.textContent = result.status === "filled" ? "✓" : "⚠";

      const text = document.createElement("div");
      text.className = "field-text";
      const labelEl = document.createElement("div");
      labelEl.className = "field-label";
      labelEl.textContent = result.label;
      text.appendChild(labelEl);
      if (result.detail) {
        const detailEl = document.createElement("div");
        detailEl.className = "field-detail";
        detailEl.textContent = result.detail;
        text.appendChild(detailEl);
      }

      row.appendChild(icon);
      row.appendChild(text);
      container.appendChild(row);
    }

    container.scrollTop = container.scrollHeight;
  }

  // Same dispatch pattern as recordResult. Also fixes a real pre-existing
  // bug while it's here: the download link's href was only ever set once,
  // in injectSidebar's initial template — at that point resumeFileUrl is
  // still usually unfetched (it's fetched on-demand, only once an actual
  // file-upload field is found, which can be well after the sidebar
  // renders), so the link likely pointed at "#" even without any iframe
  // involved. Now sets the real href at the moment it's actually shown.
  function showManualResumePrompt() {
    if (!resumeFileUrl) return;
    if (window.self !== window.top) {
      window.top.postMessage({ source: "askjobs-extension", type: "remote-resume-prompt", resumeFileUrl }, "*");
      return;
    }
    showManualResumePromptLocal(resumeFileUrl);
  }

  function showManualResumePromptLocal(url) {
    if (!sidebarShadow) return;
    const link = sidebarShadow.querySelector("#askjobs-resume-link");
    if (!link) return;
    const anchor = link.querySelector("a");
    if (anchor) anchor.href = url;
    link.classList.remove("hidden");
  }

  // Purely informational — new fields appeared (e.g. you moved to the next
  // step of a multi-step form), but we don't touch them automatically
  // anymore. Just nudges you to click "Fill this application" again.
  // Same dispatch pattern as recordResult/showAiStatus.
  function showNewFieldsPrompt() {
    if (window.self !== window.top) {
      window.top.postMessage({ source: "askjobs-extension", type: "remote-new-fields-prompt" }, "*");
      return;
    }
    if (!sidebarShadow) return;
    const counter = sidebarShadow.querySelector("#askjobs-counter");
    if (counter) counter.textContent = "New fields detected — click Fill again";
  }

  // Sets the sidebar host's position via a <style> tag's textContent
  // (targeting it through the `:host` selector from inside its own shadow
  // root) instead of the `host.style.xxx = ...` property this used to use.
  // Confirmed real: strict CSP sites (Greenhouse's MyGreenhouse portal —
  // `style-src 'self' job-seekers.cdn.greenhouse.io 'nonce-...'`) silently
  // block every inline-style property assignment, which broke the
  // sidebar's positioning, drag-to-move, icon colors, and every show/hide
  // toggle (AI status message, manual-resume-download link, the
  // field-results collapse panel) — hundreds of blocked-and-logged
  // attempts per session, one for every drag mousemove alone. A <style>
  // element's text content isn't restricted the same way (our base
  // stylesheet below already proves that — it renders fine on every site),
  // so this rewrites the same rule's text instead of ever touching
  // `.style` directly.
  //
  // Confirmed real (BambooHR), and the reason this is unconditionally
  // position:fixed again: an earlier version tried to render the sidebar
  // INSIDE whichever iframe actually held the form (BambooHR embeds its
  // real application form in one), simulating fixed positioning with JS
  // math since a non-internally-scrolling iframe can't natively track the
  // outer page's scroll. That chased one edge case after another — the
  // iframe not starting at true viewport y=0, a sticky header painted over
  // its top edge, the iframe being narrower than the true viewport and
  // clipping the sidebar's right side — because faking "fixed" inside a
  // nested, independently-laid-out box fundamentally has no end of edge
  // cases. The sidebar now ALWAYS lives in the top frame, where native
  // position:fixed just works with zero simulation; see injectSidebar's
  // top-frame-only guard and the remote-suggestion bridge below for how a
  // form living inside an iframe still gets its results shown here.
  function setHostPosition(host, styleEl, { top, left, right }) {
    const rules = [];
    if (top !== undefined) rules.push(`top: ${top}`);
    if (left !== undefined) rules.push(`left: ${left}`);
    if (right !== undefined) rules.push(`right: ${right}`);
    styleEl.textContent = `:host { position: fixed !important; z-index: 2147483647 !important; ${rules.join("; ")}; }`;
  }

  function injectSidebar() {
    // Re-creates itself if the previously-injected host was ripped out of
    // the DOM — confirmed real on React-hydrated ATS pages (Greenhouse's
    // embed widget included) that re-render their whole tree after an
    // initial load, silently wiping any sibling node appended directly to
    // <html> that React doesn't know about. scanAndFill keeps working
    // through this (it re-queries the live DOM fresh every call), but the
    // sidebar itself would otherwise vanish for good after just one such
    // re-render, with nothing left to recreate it.
    if (sidebarShadow && sidebarHost?.isConnected) return;
    sidebarShadow = null;
    sidebarHost = null;
    // Hard guard, not just a call-site convention — the sidebar UI only
    // ever lives in the top frame now (see setHostPosition's comment for
    // why). A non-top frame that finds fillable fields still scans/fills
    // them locally; its results reach this sidebar via the remote-message
    // bridge instead of rendering a second copy of the UI in its own DOM.
    if (window.self !== window.top) return;

    const host = document.createElement("div");
    host.id = "askjobs-autofill-host";
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style id="askjobs-position-style"></style>
      <style>
        .hidden { display: none !important; }
        * { box-sizing: border-box; }
        .panel {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          line-height: 1.4;
          background: #ffffff;
          color: #1f2937;
          border-radius: 16px;
          padding: 16px;
          box-shadow: 0 12px 32px rgba(15,23,42,0.16), 0 2px 8px rgba(15,23,42,0.08);
          border: 1px solid #eef0f3;
          width: 300px;
          /* Confirmed real: with both the AI-suggestions and field-results
             sections populated, the panel's total height (title + buttons +
             up to 320px of suggestions + up to 280px of results + padding)
             can easily exceed a non-maximized browser window — it ran off
             the bottom of the screen entirely, and with nowhere left to
             drag it TO, vertical dragging looked broken even after fixing
             the clamp math. Capping the panel itself to the viewport height
             (minus the same 16px margin used for its default position) with
             its own scrollbar guarantees it always fits and can always be
             dragged, instead of growing without bound. */
          max-height: calc(100vh - 32px);
          overflow-y: auto;
        }
        /* Confirmed real (Ashby's application form): text rows rendered
           visually overlapping/interleaved, even for short, ordinary fields
           (Full Name, Email...) with nothing wrong in their content. Shadow
           DOM isolates SELECTOR rules from the host page, but it does NOT
           reset inherited properties already computed on our injected host
           element before they cascade into this shadow tree — a page-wide
           reset (e.g. a Tailwind-style near-zero line-height on divs)
           applied to #askjobs-autofill-host in the light DOM flows straight
           through to every element in here unless something inside
           explicitly overrides it. The .panel rule above sets a sane
           default, but only for properties that are actually INHERITED —
           line-height and font-size are, but element box sizing isn't, so
           this belt-and-suspenders rule forces every element in the sidebar
           back to normal flow regardless of what leaked in.
        */
        .panel, .panel * { line-height: 1.4; box-sizing: border-box; }
        .title { font-weight: 700; font-size: 14px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; cursor: move; user-select: none; color: #111827; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex: 0 0 auto; }
        #askjobs-counter {
          display: inline-flex; align-items: center; font-size: 12px; font-weight: 600;
          color: #166534; background: #ecfdf5; border: 1px solid #bbf7d0; border-radius: 999px;
          padding: 4px 10px; margin-bottom: 12px; cursor: pointer;
        }
        #askjobs-counter.attention { color: #92400e; background: #fffbeb; border-color: #fde68a; }
        button {
          margin-top: 8px; width: 100%; border: none; border-radius: 10px; padding: 11px 14px;
          font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit;
          transition: opacity 0.15s ease, transform 0.05s ease;
        }
        button:active { transform: scale(0.99); }
        button:hover { opacity: 0.92; }
        button:disabled { opacity: 0.5; cursor: default; }
        #askjobs-fill-btn { background: #C02C2A; color: #fff; box-shadow: 0 4px 10px rgba(192,44,42,0.25); }
        #askjobs-ai-fill-btn { background: #f3f4f6; color: #374151; border: 1px solid #e5e7eb; }
        #askjobs-resume-link { margin-top: 10px; font-size: 11.5px; color: #6b7280; background: #f9fafb; border-radius: 8px; padding: 8px 10px; }
        #askjobs-resume-link a { color: #C02C2A; font-weight: 600; text-decoration: none; }
        #askjobs-resume-link a:hover { text-decoration: underline; }
        #askjobs-ai-status { font-size: 11.5px; color: #6b7280; margin-top: 8px; }
        #askjobs-ai-results { max-height: 320px; overflow-y: auto; margin-top: 8px; }
        .ai-item { background: #f9fafb; border: 1px solid #eef0f3; border-radius: 10px; padding: 10px; margin-top: 8px; }
        .ai-item-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 6px; margin-bottom: 6px; }
        .ai-question { font-size: 11.5px; font-weight: 600; color: #374151; }
        .ai-dismiss-btn { flex: 0 0 auto; background: none !important; border: none; color: #9ca3af;
                           font-size: 14px; line-height: 1; cursor: pointer; padding: 0 2px !important;
                           margin: 0 !important; width: auto !important; }
        .ai-dismiss-btn:hover { color: #374151; opacity: 1; }
        .ai-answer-box { width: 100%; box-sizing: border-box; font-family: inherit; font-size: 12px;
                          background: #fff; color: #1f2937; border: 1px solid #e5e7eb; border-radius: 8px;
                          padding: 8px; resize: vertical; min-height: 50px; }
        .ai-answer-box:focus { outline: none; border-color: #C02C2A; }
        .ai-insert-btn { margin-top: 6px; background: #16a34a; color: #fff; }
        #askjobs-field-results { max-height: 280px; overflow-y: auto; margin-top: 12px; border-top: 1px solid #f1f2f4; padding-top: 10px; }
        .field-row { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f6f7f8; }
        .field-row:last-child { border-bottom: none; }
        .field-icon { flex: 0 0 auto; font-size: 12px; line-height: 1.5; width: 16px; text-align: center; }
        .field-icon.icon-filled { color: #16a34a; }
        .field-icon.icon-skipped { color: #d97706; }
        .field-text { flex: 1 1 auto; min-width: 0; }
        .field-label { font-size: 12px; font-weight: 500; color: #1f2937; word-break: break-word; }
        .field-detail { font-size: 11px; color: #9ca3af; margin-top: 1px; word-break: break-word; }
      </style>
      <div class="panel">
        <div class="title"><span class="dot"></span> AskJobs Autofill</div>
        <div id="askjobs-counter" title="Click to show/hide details">Ready</div>
        <button id="askjobs-fill-btn">Fill this application</button>
        <button id="askjobs-ai-fill-btn">AI-fill remaining questions</button>
        <div id="askjobs-ai-status" class="hidden"></div>
        <div id="askjobs-ai-results"></div>
        <div id="askjobs-field-results"></div>
        <div id="askjobs-resume-link" class="hidden">
          Couldn't auto-attach your resume —
          <a href="${resumeFileUrl || "#"}" target="_blank" rel="noopener noreferrer">download it here</a>
          and attach it manually.
        </div>
      </div>
    `;

    sidebarShadow = shadow;
    sidebarHost = host;
    setHostPosition(host, shadow.querySelector("#askjobs-position-style"), { top: "16px", right: "16px" });
    shadow.querySelector("#askjobs-fill-btn").addEventListener("click", () => triggerEverywhere("remote-trigger-fill"));
    shadow.querySelector("#askjobs-ai-fill-btn").addEventListener("click", () => triggerEverywhere("remote-trigger-ai-fill"));
    shadow.querySelector("#askjobs-counter").addEventListener("click", () => {
      const details = shadow.querySelector("#askjobs-field-results");
      details.classList.toggle("hidden");
    });
    makeDraggable(host, shadow.querySelector(".title"), shadow.querySelector("#askjobs-position-style"));
  }

  // Drags by the title bar — updates the host's own top/left (switching off
  // the initial top/right positioning once moved) and clamps to the
  // viewport so it can't be dragged off-screen and become unreachable.
  function makeDraggable(host, handle, positionStyle) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      const rect = host.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      // Confirmed real: the sidebar's content (title + buttons + AI
      // suggestion cards + field results) can easily run 700-800px tall —
      // taller than a non-maximized browser window. window.innerHeight -
      // host.offsetHeight then goes NEGATIVE, and Math.min against a
      // negative number pins y to that same negative value no matter where
      // the mouse is — vertical dragging looked completely dead while
      // horizontal (bounded by the much smaller sidebar width, rarely
      // exceeding the window's width) worked fine. Clamping each max bound
      // to at least 0 keeps genuine dragging room whenever the sidebar
      // actually fits, and degrades to "pinned at the edge" instead of
      // "stuck at an unreachable negative offset" when it doesn't.
      const maxX = Math.max(0, window.innerWidth - host.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - host.offsetHeight);
      const x = Math.max(0, Math.min(maxX, e.clientX - offsetX));
      const y = Math.max(0, Math.min(maxY, e.clientY - offsetY));
      setHostPosition(host, positionStyle, { top: `${y}px`, left: `${x}px` });
    });

    document.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  // Same dispatch pattern as recordResult — see its comment.
  function showAiStatus(text) {
    if (window.self !== window.top) {
      window.top.postMessage({ source: "askjobs-extension", type: "remote-ai-status", text }, "*");
      return;
    }
    if (!sidebarShadow) return;
    const status = sidebarShadow.querySelector("#askjobs-ai-status");
    if (!status) return;
    status.textContent = text;
    status.classList.toggle("hidden", !text);
  }

  // Fields still empty after the deterministic pass, with a resolvable
  // label that reads like an actual question — not just any empty field.
  // These go to the AI-fill path, never auto-answered.
  // True for the "Select..."-style custom dropdown widgets handled by
  // fillCustomCombobox (Workday's button[aria-haspopup="listbox"],
  // Darwinbox/react-select's [role="combobox"] — including the case where
  // that role sits directly on an <input type="text">, which is why this
  // check has to run before collectUnansweredQuestions treats a text input
  // as free text).
  function isComboboxField(field) {
    return field.matches('[role="combobox"]') || field.getAttribute("aria-haspopup") === "listbox";
  }

  // Confirmed real, from a live screening-questions pass: "Please choose
  // the country in which you are located" and "Will you require sponsorship
  // if you join Remote?" are both react-select-style comboboxes whose
  // trigger IS an <input type="text">, not a <button> — so they were
  // getting swept into this function's plain-text scan too, alongside
  // scanAndFillGenericComboboxes's own button/role=combobox scan. Answering
  // them as free text (typing straight into that input) never actually
  // selects an option — the widget just discards it or leaves its own
  // dropdown open on an unmatched search string — so "Insert" looked like
  // it did nothing.
  //
  // Items are returned in the same {kind, ...} shape pendingClassificationItems
  // already uses (see maybeQueueFieldForClassification et al.) so this can
  // feed straight into the existing runQualificationAnswerPass /
  // renderQualificationAnswers, instead of a second parallel rendering path
  // — that pass already reads the resume server-side and, for kind
  // "combobox", already constrains the AI's answer to one of `options`
  // (answer-qualification-questions), which for comboboxes are gathered
  // eagerly below via the same gatherComboboxOptions used by the automatic
  // classification queue, rather than left for fillCustomCombobox to
  // discover only as a fallback once Insert is clicked.
  async function collectUnansweredQuestions(root) {
    const items = [];
    const fields = deepQueryAll(root, "textarea, input[type='text']");
    for (const field of fields) {
      if (field.disabled || field.value) continue;
      // Already sitting in the automatic classification queue from this same
      // fill pass (maybeQueueFieldForClassification) — that queue chains
      // straight into runQualificationAnswerPass for anything it can't
      // place, same as this function does, so re-collecting it here would
      // just render a second, identical suggestion card. Confirmed real:
      // "Desired Salary" got suggested twice — once from the automatic
      // pass, once from clicking "AI-fill remaining questions" — because a
      // review-before-insert suggestion never sets field.value, so the
      // field still looked entirely untouched on the second scan.
      if (queuedFieldSignatures.has(fieldSignature(field))) continue;
      if (isComboboxField(field)) continue; // handled by the combobox scan below
      if (classify(field)) continue; // already handled deterministically
      // Recognized as a structured education/experience value (a GPA,
      // degree name, graduation year, job title, etc.) even if we didn't
      // have data to fill it — these want a specific short answer, not an
      // AI-generated essay, and were mis-answered as one before this check
      // existed (e.g. "Overall Result (GPA)" got a paragraph about
      // "strong academic foundation" instead of a number).
      if (classifyStructured(field, EDUCATION_FIELD_MATCHERS)) continue;
      if (classifyStructured(field, EXPERIENCE_FIELD_MATCHERS)) continue;
      // Confirmed real (CATS One): a masked "Date Available" field ended up
      // here too and got a free-text "Immediately" suggestion — a
      // reasonable phrase, not a valid value for a field expecting an
      // actual calendar date. See isDateShapedField's comment.
      if (isDateShapedField(field)) continue;

      const label = (
        labelForField(field) ||
        field.getAttribute("aria-label") ||
        field.getAttribute("placeholder") ||
        ""
      ).trim();
      // Too short to plausibly be a real question — avoids scooping up
      // stray unlabeled/cosmetic fields as if they were screening questions.
      // Too long is rejected too: a real question is never this long, so
      // it's almost certainly an over-broad label capture (a container that
      // swept up unrelated surrounding text, e.g. a full legal notice) —
      // sending that to AI as a "question" wastes tokens and, worse, its
      // sheer bulk makes an accidental keyword collision with a sensitive
      // category (ethnicity, disability, ...) far more likely than a real
      // short question would ever produce.
      if (label.length < 10 || label.length > MAX_QUESTION_LABEL_LENGTH) continue;

      items.push({ kind: "field", field, questionText: label, fieldType: field.type || "text" });
    }

    const comboButtons = deepQueryAll(root, 'button[aria-haspopup="listbox"], [role="combobox"]');
    for (const button of comboButtons) {
      if (button.disabled) continue;
      const signature = fieldSignature(button);
      // Already sitting in the other AI queue (runClassificationPass) —
      // this is a general catch-all for whatever's left, not a duplicate
      // attempt at something already queued there. Deliberately NOT gated
      // on attemptedSignatures the way the plain-field scan is above: for
      // comboboxes, scanAndFillGenericComboboxes marks a signature
      // "attempted" the moment it TRIES a deterministic Yes/No fill, even
      // if that fill then fails to find a matching option — confirmed real
      // (the exact bug this whole feature exists to fix): "Will you
      // require sponsorship" got marked attempted, failed to match "Yes"
      // against whatever actually renders, and would otherwise never get a
      // second, AI-assisted try.
      if (queuedFieldSignatures.has(signature)) continue;

      const currentText = normalize(visibleText(button) || button.value || "");
      if (currentText && !PLACEHOLDER_OPTION_TEXT.test(currentText)) continue; // already answered

      const label = (labelForField(button) || button.getAttribute("aria-label") || "").trim();
      if (label.length < 10 || label.length > MAX_QUESTION_LABEL_LENGTH) continue;

      // Same guard scanAndFillGenericComboboxes already applies before ever
      // touching one of these — demographic self-ID questions (ethnicity,
      // disability, gender identity, sexual orientation, transgender
      // status) are never sent to AI, only flagged for the candidate to
      // answer directly. Confirmed real gap without this: "What is your
      // Race/Ethnicity?" was reaching gatherComboboxOptions from this scan
      // even though the automatic pass had already correctly left it alone.
      const normalizedLabel = normalize(label);
      if (
        isSensitiveSelfIdQuestion(normalizedLabel) ||
        isGenderIdentityQuestion(normalizedLabel) ||
        isDisabilityQuestion(normalizedLabel) ||
        isCountryQuestion(normalizedLabel)
      ) continue;

      const options = await gatherComboboxOptions(button);
      items.push({ kind: "combobox", button, questionText: label, fieldType: "combobox", options });
    }

    return items;
  }

  async function handleAiFillClick() {
    showAiStatus("Scanning for unanswered questions...");
    const items = await collectUnansweredQuestions(document);
    if (items.length === 0) {
      showAiStatus("No open-ended questions found to answer.");
      return;
    }
    await runQualificationAnswerPass(items);
  }

  // Every suggestion card gets a dismiss (✕) button, not just an Insert
  // button — these can go stale across a multi-step form (a suggestion for
  // "Middle Name" from the My Information step is still sitting there once
  // you've moved on to Education), so there needs to be a way to clear one
  // without inserting anything.
  function createSuggestionItem(questionText) {
    const item = document.createElement("div");
    item.className = "ai-item";

    const header = document.createElement("div");
    header.className = "ai-item-header";
    const q = document.createElement("div");
    q.className = "ai-question";
    q.textContent = questionText;
    const dismissBtn = document.createElement("button");
    dismissBtn.className = "ai-dismiss-btn";
    dismissBtn.textContent = "✕";
    dismissBtn.title = "Dismiss";
    dismissBtn.addEventListener("click", () => item.remove());
    header.appendChild(q);
    header.appendChild(dismissBtn);
    item.appendChild(header);

    return item;
  }

  // Relays a suggestion this (non-top) frame generated to the top frame's
  // sidebar for display, since there's no local sidebar to render into
  // here (see injectSidebar's top-frame-only guard). onInsert is kept
  // LOCALLY, never serialized — it's a closure over a live DOM
  // element/button only this frame can reference. When the candidate
  // clicks Insert on the top frame's card, a remote-insert-request message
  // comes back here with just the id (see the message listener below), and
  // this frame looks up and runs the real callback itself.
  function sendRemoteSuggestion(questionText, previewText, editable, onInsert) {
    const id = `${Date.now()}-${remoteSuggestionIdCounter++}`;
    pendingRemoteInserts.set(id, onInsert);
    window.top.postMessage(
      { source: "askjobs-extension", type: "remote-suggestion", id, questionText, previewText, editable },
      "*"
    );
  }

  // Renders one review-before-insert suggestion card — locally, if this IS
  // the top frame (where the sidebar lives), or relayed to it otherwise.
  // Replaces what used to be near-identical ad-hoc card-creation code
  // copy-pasted at every call site (stored-value suggestions, classified
  // fields, radio/checkbox/button-toggle groups, comboboxes, the resume-
  // reading qualification pass) — one shared renderer, one place the
  // remote bridge needs to be wired in.
  //
  // `editable`: true shows an editable textarea seeded with previewText,
  // and onInsert receives whatever's actually in it at click-time; false
  // shows a plain preview line and onInsert takes no argument (the value's
  // already baked in via closure — e.g. a stored gender/disability value).
  // onInsert is responsible for calling recordResult itself once done — the
  // right DOM action varies far too much by field shape (setNativeValue,
  // fillCustomCombobox, setNativeChecked, a plain click...) to have one
  // shared strategy here. Always awaited (harmless even if onInsert isn't
  // actually async) so the card stays visible until the action finishes,
  // not just until it starts.
  function showSuggestionCard(questionText, previewText, editable, onInsert) {
    if (window.self !== window.top) {
      sendRemoteSuggestion(questionText, previewText, editable, onInsert);
      return;
    }
    const container = sidebarShadow?.querySelector("#askjobs-ai-results");
    if (!container) return;

    const el = createSuggestionItem(questionText);
    const btn = document.createElement("button");
    btn.className = "ai-insert-btn";
    btn.textContent = "Insert";

    if (editable) {
      const textarea = document.createElement("textarea");
      textarea.className = "ai-answer-box";
      textarea.value = previewText;
      btn.addEventListener("click", async () => {
        const finalValue = textarea.value;
        if (!finalValue) return;
        await onInsert(finalValue);
        el.remove();
      });
      el.appendChild(textarea);
    } else {
      const preview = document.createElement("div");
      preview.className = "ai-question";
      preview.textContent = previewText;
      btn.addEventListener("click", async () => {
        await onInsert();
        el.remove();
      });
      el.appendChild(preview);
    }
    el.appendChild(btn);
    container.appendChild(el);
  }

  // Bridges BOTH directions of the remote-suggestion flow over postMessage
  // (works regardless of whether the iframe happens to be same- or
  // cross-origin, same reasoning as every other cross-frame message in this
  // file): a non-top frame's remote-field-result/remote-ai-status/
  // remote-suggestion arriving here (only acted on in the top frame, where
  // the real sidebar lives), and a remote-insert-request arriving back at
  // whichever frame originated a suggestion (only acted on in non-top
  // frames, since only they hold the real callback).
  window.addEventListener("message", (event) => {
    if (event.data?.source !== "askjobs-extension") return;

    if (window.self === window.top) {
      if (event.data.type === "remote-field-result") {
        recordResultLocal(event.data.status, event.data.label, event.data.detail);
      } else if (event.data.type === "remote-ai-status") {
        showAiStatus(event.data.text);
      } else if (event.data.type === "remote-suggestion") {
        const { id, questionText, previewText, editable } = event.data;
        remoteSuggestionSources.set(id, event.source);
        showSuggestionCard(questionText, previewText, editable, (finalValue) => {
          remoteSuggestionSources.get(id)?.postMessage(
            { source: "askjobs-extension", type: "remote-insert-request", id, finalValue },
            "*"
          );
          remoteSuggestionSources.delete(id);
        });
      } else if (event.data.type === "remote-resume-prompt") {
        showManualResumePromptLocal(event.data.resumeFileUrl);
      } else if (event.data.type === "remote-new-fields-prompt") {
        showNewFieldsPrompt();
      } else if (event.data.type === "remote-reset-results") {
        resetDisplayLocal();
      }
    } else if (event.data.type === "remote-insert-request") {
      const onInsert = pendingRemoteInserts.get(event.data.id);
      pendingRemoteInserts.delete(event.data.id);
      onInsert?.(event.data.finalValue);
    } else if (event.data.type === "remote-trigger-fill") {
      scanAndFill(document);
    } else if (event.data.type === "remote-trigger-ai-fill") {
      handleAiFillClick();
    }
  });

  // Confirmed real gap: since the sidebar UI only ever lives in the top
  // frame now, its own "Fill this application"/"AI-fill remaining
  // questions" buttons would otherwise only ever scan the TOP frame's own
  // document — for a page like BambooHR, where the real form is entirely
  // inside an iframe, clicking them would silently do nothing at all. The
  // popup's TRIGGER_FILL already reaches every frame (it's relayed through
  // chrome.tabs.sendMessage by the background), but a content script can't
  // call that API itself without first learning its own tabId — simplest
  // fix is the same postMessage broadcast already used elsewhere in this
  // file: tell every child iframe directly, no background round-trip
  // needed.
  function triggerEverywhere(type) {
    if (type === "remote-trigger-fill") scanAndFill(document);
    else handleAiFillClick();
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        iframe.contentWindow?.postMessage({ source: "askjobs-extension", type }, "*");
      } catch {
        // Cross-origin iframe whose contentWindow rejected the call — this
        // frame's own fields (if any) already got handled above regardless.
      }
    }
  }

  // Review-before-insert card sourced directly from stored profile data
  // (not AI) — used for things like gender identity, where we have an
  // actual answer the candidate already gave us elsewhere, so there's no
  // reasoning step and no network round-trip, just "here's what you told
  // us, insert it if it's right for this question's wording."
  function renderStoredValueSuggestion(questionText, suggestedText, onInsert) {
    showSuggestionCard(questionText, `Suggested answer (from your profile): ${suggestedText}`, false, onInsert);
  }

  // Renders one review-before-insert card per classified item that we also
  // have real data to answer with. Recognized-but-no-data items (e.g. a
  // classified "willingToRelocate" question when that preference was never
  // set) are silently skipped here — same principle as the rest of the
  // file: never insert a guess, only a value the user actually provided
  // somewhere (profile, resume, or Settings → Screening Questions).
  //
  // Anything still unrecognized after this fixed-category pass is
  // returned as `unresolved` — not dropped — so the caller can hand it to
  // the broader qualification-answering AI pass instead.
  function renderClassifiedSuggestions(items, classifications) {
    let addedCount = 0;
    const unresolved = [];

    items.forEach((item, i) => {
      const key = classifications[i];
      if (!key) {
        unresolved.push(item);
        return;
      }

      if (item.kind === "field") {
        const value = key === "skills" ? resumeSkills.join(", ") : valueForKey(key);
        if (!value) return; // Recognized, but no stored data — a known category with genuinely nothing to answer with, not a candidate for resume-reading AI either.

        showSuggestionCard(item.questionText, value, true, async (finalValue) => {
          if (key === "skills") {
            await fillSkillsField(item.field);
          } else if (item.field.tagName === "TEXTAREA") {
            typeCharacterByCharacter(item.field, finalValue);
          } else {
            setNativeValue(item.field, finalValue);
          }
          recordResult("filled", item.questionText, `${finalValue} (AI-classified, reviewed)`);
        });
        addedCount += 1;
      } else if (item.kind === "radioGroup") {
        const answer = radioAnswerForKey(key);
        if (answer === null) return;

        const wantedText = answer ? "yes" : "no";
        const target = item.radios.find((r) => {
          const label = normalize(labelForField(r) || r.value || "");
          return label === wantedText || label.startsWith(wantedText);
        });
        if (!target) return;

        showSuggestionCard(item.questionText, `Suggested answer: ${answer ? "Yes" : "No"}`, false, () => {
          setNativeChecked(target);
          recordResult("filled", item.questionText, `${answer ? "Yes" : "No"} (AI-classified, reviewed)`);
        });
        addedCount += 1;
      } else if (item.kind === "buttonToggleGroup") {
        const answer = radioAnswerForKey(key);
        if (answer === null) return;

        const wantedWord = answer ? "yes" : "no";
        const target = item.buttons.find((b) => normalize(b.textContent || "") === wantedWord);
        if (!target) return;

        showSuggestionCard(item.questionText, `Suggested answer: ${answer ? "Yes" : "No"}`, false, () => {
          target.click();
          recordResult("filled", item.questionText, `${answer ? "Yes" : "No"} (AI-classified, reviewed)`);
        });
        addedCount += 1;
      } else if (item.kind === "combobox") {
        // Two different kinds of "key" can come back here: boolean
        // screening categories (workAuthorized, visaSponsorshipNeeded,
        // workedHereBefore, atLeast18, ...), answered via radioAnswerForKey,
        // and value-lookup categories (addressCountry, location, firstName,
        // ...), answered via valueForKey. radioAnswerForKey already returns
        // null for any key it doesn't specifically handle, so trying it
        // first and falling back to valueForKey is safe. Confirmed real gap
        // without the fallback: classify-fields correctly identified
        // "Please choose the country..." as addressCountry, but this branch
        // only ever tried radioAnswerForKey — which returns null for
        // anything it doesn't recognize — so the suggestion silently
        // vanished no matter how correct the upstream classification was.
        const boolAnswer = radioAnswerForKey(key);
        const wantedText =
          boolAnswer !== null
            ? boolAnswer
              ? "Yes"
              : "No"
            : key === "skills"
              ? resumeSkills.join(", ")
              : valueForKey(key);
        if (!wantedText) return;

        showSuggestionCard(item.questionText, `Suggested answer: ${wantedText}`, false, async () => {
          const filled = await fillCustomCombobox(item.button, wantedText, item.questionText);
          recordResult(filled ? "filled" : "skipped", item.questionText, filled ? `${wantedText} (AI-classified, reviewed)` : "Couldn't find a matching option");
        });
        addedCount += 1;
      }
    });

    return { addedCount, unresolved };
  }

  // Batched AI-classification fallback for fields/radio-groups the fast
  // deterministic matchers couldn't identify — sends only a lightweight
  // {label, type, options} list (no raw HTML, no PII beyond the form's own
  // question text) and only ever surfaces a review-before-insert suggestion,
  // never auto-filling. Runs once per fill pass (page load, or an explicit
  // "Fill this application"/popup click), not per field.
  async function runClassificationPass() {
    if (pendingClassificationItems.length === 0) return;

    const items = pendingClassificationItems;
    pendingClassificationItems = [];

    showAiStatus(`Checking ${items.length} unrecognized field(s) with AI...`);

    const response = await sendMessage({
      type: "API_FETCH",
      path: "/api/v1/extension/classify-fields",
      options: {
        method: "POST",
        body: JSON.stringify({
          fields: items.map((item) => ({
            label: item.questionText,
            type: item.fieldType,
            options: item.options,
          })),
        }),
      },
    });

    if (!response?.ok) {
      console.warn("[AskJobs] classify-fields failed:", response);
      showAiStatus("");
      return;
    }

    const classifications = response.data?.classifications || [];
    const { addedCount, unresolved } = renderClassifiedSuggestions(items, classifications);
    showAiStatus(
      addedCount > 0
        ? `AI found ${addedCount} likely answer(s) below — review and click Insert.`
        : ""
    );

    // Still-unrecognized items (not one of the fixed personal-info/screening
    // categories) go to the broader qualification-answering pass, which
    // reasons over the actual resume instead of matching against a fixed
    // category list — e.g. "Do you have 2+ years of Java experience?".
    await runQualificationAnswerPass(unresolved);
  }

  // Renders one review-before-insert card per question the resume-reading
  // AI pass answered — covers any of the three item shapes (plain
  // field/select, native radio group, custom combobox button), always
  // editable before insert since this is a genuine judgment call, not a
  // simple lookup.
  function renderQualificationAnswers(items, answers) {
    let addedCount = 0;

    items.forEach((item, i) => {
      const answer = answers[i];
      if (!answer) return; // Not enough evidence in the resume — left unanswered, not guessed.

      if (item.kind === "radioGroup" || item.kind === "checkboxGroup") {
        const boxes = item.kind === "radioGroup" ? item.radios : item.boxes;
        showSuggestionCard(item.questionText, `Suggested answer: ${answer}`, false, () => {
          const target = boxes.find((r) => normalize(labelForField(r) || r.value || "") === normalize(answer));
          if (target) {
            setNativeChecked(target);
            recordResult("filled", item.questionText, `${answer} (AI-answered from resume, reviewed)`);
          } else {
            recordResult("skipped", item.questionText, "Couldn't find a matching option");
          }
        });
      } else if (item.kind === "buttonToggleGroup") {
        showSuggestionCard(item.questionText, `Suggested answer: ${answer}`, false, () => {
          const target = item.buttons.find((b) => normalize(b.textContent || "") === normalize(answer));
          if (target) {
            target.click();
            recordResult("filled", item.questionText, `${answer} (AI-answered from resume, reviewed)`);
          } else {
            recordResult("skipped", item.questionText, "Couldn't find a matching option");
          }
        });
      } else {
        // "field" (text/select) and "combobox" both get an editable box —
        // for combobox specifically, the real options only render once
        // opened, so fillCustomCombobox does its own matching at insert
        // time against whatever actually appears.
        showSuggestionCard(item.questionText, answer, true, async (finalValue) => {
          if (item.kind === "combobox") {
            const filled = await fillCustomCombobox(item.button, finalValue, item.questionText);
            recordResult(filled ? "filled" : "skipped", item.questionText, filled ? `${finalValue} (AI-answered from resume, reviewed)` : "Couldn't find a matching option");
          } else if (item.field.tagName === "SELECT") {
            const option = Array.from(item.field.options).find((o) => o.textContent.trim() === finalValue);
            if (option) {
              item.field.value = option.value;
              item.field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
              recordResult("filled", item.questionText, `${finalValue} (AI-answered from resume, reviewed)`);
            } else {
              recordResult("skipped", item.questionText, "Couldn't find a matching option");
            }
          } else if (item.field.tagName === "TEXTAREA") {
            typeCharacterByCharacter(item.field, finalValue);
            recordResult("filled", item.questionText, `${finalValue} (AI-answered from resume, reviewed)`);
          } else {
            setNativeValue(item.field, finalValue);
            recordResult("filled", item.questionText, `${finalValue} (AI-answered from resume, reviewed)`);
          }
        });
      }

      addedCount += 1;
    });

    return addedCount;
  }

  // Broader fallback for anything the fixed-category classifier (classify-
  // fields) couldn't place — reads the candidate's actual resume/profile
  // (server-side, in the backend controller) to answer questions like "Do
  // you have 2+ years of Java experience?" that no keyword list could
  // anticipate. Covers any of the three item shapes uniformly; always
  // review-before-insert, same as every other AI-sourced value in this file.
  async function runQualificationAnswerPass(unresolvedItems) {
    if (!unresolvedItems || unresolvedItems.length === 0) return;
    if (!pendingHandoff?.candidateId) return;

    showAiStatus(`Reading the candidate's resume to answer ${unresolvedItems.length} more question(s)...`);

    const response = await sendMessage({
      type: "API_FETCH",
      path: "/api/v1/extension/answer-qualification-questions",
      options: {
        method: "POST",
        body: JSON.stringify({
          candidateId: pendingHandoff.candidateId,
          jobTitle: pendingHandoff?.jobTitle,
          company: pendingHandoff?.companyName,
          questions: unresolvedItems.map((item) => ({
            questionText: item.questionText,
            options: item.options,
          })),
        }),
      },
    });

    if (!response?.ok) {
      console.warn("[AskJobs] answer-qualification-questions failed:", response);
      showAiStatus(response?.status === 429 ? "AI rate limit reached — try again later." : "Couldn't reach AI for the remaining question(s).");
      return;
    }

    const answers = response.data?.answers || [];
    const addedCount = renderQualificationAnswers(unresolvedItems, answers);
    showAiStatus(
      addedCount > 0
        ? `AI found ${addedCount} more likely answer(s) below — review and click Insert.`
        : "AI couldn't find enough on your resume to answer the remaining question(s)."
    );
  }

  // EDUCATION_FIELD_MATCHERS/CERTIFICATION_FIELD_MATCHERS/WEBSITE_FIELD_MATCHERS
  // (defined above, reused unchanged from OG) read entries by exact property
  // name (entryData[key] in fillRepeatedEntries) — this reshapes our raw
  // Candidate.education/certifications fields into the property names those
  // matchers already expect, rather than touching the matcher lists
  // themselves. `experience` needs no reshaping — its field names already
  // match (title/company/location/startDate/endDate/description).
  function adaptCandidateProfile(candidate) {
    return {
      ...candidate,
      education: (candidate.education || []).map((e) => ({
        institution: e.institution,
        degree: e.degree,
        field: e.fieldOfStudy,
        graduationYear: e.endDate ? new Date(e.endDate).getFullYear() : undefined,
        gpa: e.gpa,
      })),
      certifications: (candidate.certifications || []).map((c) => ({
        name: c.name,
        issuer: c.issuer,
        date: c.issueDate,
        url: c.credentialUrl,
      })),
      websites: [candidate.linkedinUrl, candidate.githubUrl, candidate.portfolioUrl].filter(Boolean),
    };
  }

  async function init() {
    console.log("[AskJobs] content script loaded on", location.hostname);

    // Belt-and-suspenders — manifest content_scripts.matches already
    // restricts injection to supported hosts, this just double-checks.
    const supportCheck = await sendMessage({ type: "IS_SITE_SUPPORTED", hostname: location.hostname });
    console.log("[AskJobs] site supported?", supportCheck);
    if (!supportCheck?.supported) return;

    // A single check here loses a real race almost every time: the new tab
    // opens (and this script runs) IMMEDIATELY on "Apply with Autofill"
    // click, synchronously, to dodge the popup blocker — but the actual
    // handoff message isn't sent from the AskJobs tab until AFTER PDF
    // generation, a Firebase Storage upload, and the backend save all
    // finish, which can take several real seconds. Poll for a few seconds
    // instead of checking once, so this tab is still around by the time
    // the handoff actually lands. Cheap to keep polling — background.js's
    // queue is tab-bound, so this can't steal a handoff meant for another
    // tab even if a few polls happen before the right one shows up.
    let handoffResult = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      handoffResult = await sendMessage({ type: "GET_PENDING_HANDOFF", hostname: location.hostname });
      if (handoffResult?.pendingHandoff) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    pendingHandoff = handoffResult?.pendingHandoff || null;
    console.log("[AskJobs] pending handoff:", pendingHandoff);

    // Unlike OG (any logged-in user can autofill their own profile), every
    // session here is scoped to one specific candidate application — there's
    // no "whoever's logged in" fallback, so without a handoff there's
    // nothing to autofill from at all.
    if (!pendingHandoff?.candidateId) {
      console.warn('[AskJobs] no pending handoff for this tab — open this page via "Apply" from the Consultant app.');
      return;
    }

    const profileResult = await sendMessage({
      type: "API_FETCH",
      path: `/api/v1/candidates/${pendingHandoff.candidateId}`,
    });
    console.log("[AskJobs] candidate profile fetch result:", profileResult);
    if (!profileResult?.ok) {
      console.warn("[AskJobs] not connected or candidate fetch failed — stopping. Check the extension's Options page for a saved token.");
      return;
    }

    profile = profileResult.data ? adaptCandidateProfile(profileResult.data) : null;
    if (!profile) {
      console.warn("[AskJobs] candidate fetch succeeded but returned no data:", profileResult.data);
      return;
    }

    // Real, candidate opt-in EEO answers (CandidateEeoProfile) — used only
    // for the narrow set of categories this file already treats as safe to
    // suggest from stored data (workAuthorized/visaSponsorshipNeeded via
    // radioAnswerForKey, gender/disability via bestGenderOptionText/
    // bestDisabilityOptionText — all still review-before-insert, never
    // auto-inserted, same as OG). Race, ethnicity, sexual orientation, and
    // veteran status are deliberately NEVER auto-filled regardless of
    // whether real data exists here — isSensitiveSelfIdQuestion blocks
    // those categories outright by design, not because the data's missing.
    const eeoResult = await sendMessage({
      type: "API_FETCH",
      path: `/api/v1/candidates/${pendingHandoff.candidateId}/eeo`,
    });
    console.log("[AskJobs] candidate EEO fetch result:", eeoResult);
    const eeo = eeoResult?.ok ? eeoResult.data || {} : {};
    eeoProfile = eeo;

    profile.gender = eeo.gender || undefined;
    jobPreferences = {
      workAuthorized: eeo.workAuthorized === "yes" ? true : eeo.workAuthorized === "no" ? false : undefined,
      visaSponsorshipNeeded:
        eeo.requiresSponsorship === "yes" ? true : eeo.requiresSponsorship === "no" ? false : undefined,
      // Candidate.openToRelocate (not EEO) — a real, consultant-set field
      // like any other candidate profile field, defaulting true only
      // because that's the schema's own default absent explicit review.
      willingToRelocate: typeof profile.openToRelocate === "boolean" ? profile.openToRelocate : undefined,
      disabilityStatus:
        eeo.disability === "yes" ? "yes" : eeo.disability === "no" ? "no" : eeo.disability === "decline_to_answer" ? "prefer not to say" : undefined,
    };

    // Skills are needed broadly and early (the Skills field can appear on
    // the very first page), so fetched eagerly here — this also resolves
    // resumeFileUrl/resumeCoverLetter as a side effect, but
    // attachResumeFile() still re-fetches fresh whenever an actual upload
    // field is found, in case this snapshot goes stale many pages later.
    await getResumeFileUrl();

    // Confirmed real (BambooHR): the actual application form is rendered
    // inside an <iframe>, invisible to a content script that only runs in
    // the top-level frame — manifest.json sets all_frames: true so this
    // init() runs (and can scan/fill) inside a matching iframe too, not
    // just the top page. Several approaches to the VISIBLE sidebar UI were
    // tried and discarded here (only the top frame shows one — but then an
    // iframe-hosted form's suggestions had nowhere to render at all; an
    // election between frames reporting field counts — but that chased one
    // race condition and one iframe-positioning edge case after another,
    // never fully converging). The sidebar now ALWAYS lives in the top
    // frame (injectSidebar no-ops in any other frame — see its own guard),
    // full stop, no election needed. A non-top frame that finds fillable
    // fields still scans/fills them locally exactly as before; its results
    // reach this sidebar via the remote-suggestion/remote-field-result
    // postMessage bridge (see sendRemoteRecord / sendRemoteSuggestion and
    // the message listener near injectSidebar) instead of trying to render
    // a second copy of the UI inside the iframe's own layout.
    if (window.self === window.top) injectSidebar();
    scanAndFill(document);

    // SPA/multi-step ATS forms (Workday included) render new fields after
    // the initial load, as you move between steps. We deliberately do NOT
    // auto-fill those in the background anymore — every version of that
    // (immediate, debounced, signature-tracked) still ended up interfering
    // with real clicks on Sign In/Create Account/Save & Continue, because
    // these SPAs often recreate the same field as a fresh DOM node (with a
    // fresh auto-generated id, in some cases) on their own re-renders,
    // which looks identical to "a genuinely new field" from the outside.
    // Fighting that arms race wasn't worth the risk of silently breaking
    // page functionality. Instead: only fill on page load and on an
    // explicit "Fill this application" click (sidebar or popup) — this
    // observer just detects new fields and prompts you to click again,
    // it never touches the DOM itself.
    let promptTimer = null;
    const observer = new MutationObserver((mutations) => {
      // Ignore mutations caused by our own fill pass (e.g. clicking "Add
      // Education" to reveal a repeated entry) — see fillInProgress's own
      // comment for the confirmed real bug this avoids.
      if (fillInProgress) return;
      let sawNewField = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.("input, select, textarea") || node.querySelector?.("input, select, textarea")) {
            sawNewField = true;
          }
        }
      }
      if (!sawNewField) return;

      clearTimeout(promptTimer);
      promptTimer = setTimeout(() => showNewFieldsPrompt(), 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Manual trigger from the popup ("Fill this application" button there).
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "TRIGGER_FILL") {
      scanAndFill(document);
      sendResponse({ ok: true });
    }
  });

  init();
})();
