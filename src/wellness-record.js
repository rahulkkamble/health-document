// App.js
import React, { useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import "bootstrap/dist/css/bootstrap.min.css";

/*
  Wellness Record Builder — corrected for NDHM profile validation.
  - Fetch /patients.json
  - Patient dropdown (name/gender/dob/mrn displayed)
  - ABHA address dropdown (appears after patient selected)
  - Single practitioner (GLOBAL_PRACTITIONER) used as author/attester/performer
  - Generates a NDHM-friendly FHIR Bundle (Composition, Patient, Practitioner, Observations)
  - Fixes:
    - Composition.section: text is an object (status/div) or entry[] non-empty
    - Observation.code uses LOINC or SNOMED (slice match)
    - coding.display uses official strings / or omitted to avoid mismatches
    - Observations have non-empty text.div
    - Identifiers have type.coding.display
*/

const NDHM_PATIENT_PROFILE = "https://nrces.in/ndhm/fhir/r4/StructureDefinition/Patient";
const NDHM_PRACTITIONER_PROFILE = "https://nrces.in/ndhm/fhir/r4/StructureDefinition/Practitioner";
const NDHM_WELLNESS_COMPOSITION = "https://nrces.in/ndhm/fhir/r4/StructureDefinition/WellnessRecord";
const OBS_PHYSICAL_PROFILE = "https://nrces.in/ndhm/fhir/r4/StructureDefinition/ObservationPhysicalActivity";
const OBS_GENERAL_PROFILE = "https://nrces.in/ndhm/fhir/r4/StructureDefinition/ObservationGeneralAssessment";
const OBS_LIFESTYLE_PROFILE = "https://nrces.in/ndhm/fhir/r4/StructureDefinition/ObservationLifestyle";

const V2_0203 = "http://terminology.hl7.org/CodeSystem/v2-0203";

/* single practitioner (global) */
const GLOBAL_PRACTITIONER = {
  loginId: "pract-001",
  name: "Dr. ABC",
  license: "LIC-1234",
};

/* helpers */
const isUuid = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

function ddmmyyyyToISO(v) {
  if (!v) return "";
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const sep = s.includes("-") ? "-" : s.includes("/") ? "/" : null;
  if (!sep) return "";
  const parts = s.split(sep);
  if (parts.length !== 3) return "";
  const [dd, mm, yyyy] = parts;
  if (yyyy && yyyy.length === 4) return `${yyyy.padStart(4, "0")}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  return "";
}

function extractAbhaAddresses(apiPatient) {
  const raw = apiPatient?.additional_attributes?.abha_addresses;
  if (!Array.isArray(raw)) {
    return apiPatient?.abha_ref ? [String(apiPatient.abha_ref)] : [];
  }
  return Array.from(
    new Set(
      raw
        .map((it) => {
          if (!it) return null;
          if (typeof it === "string") return it;
          if (typeof it === "object") {
            if (it.address) return String(it.address);
            return JSON.stringify(it);
          }
          return null;
        })
        .filter(Boolean)
    )
  );
}

function mapApiToForm(apiP) {
  return {
    api: apiP,
    resourceId: isUuid(apiP?.user_ref_id) ? apiP.user_ref_id.toLowerCase() : "",
    displayName: apiP?.name || "",
    gender: (apiP?.gender || "").toLowerCase(),
    birthDate: ddmmyyyyToISO(apiP?.dob) || "",
    mobile: apiP?.mobile || "",
    address: apiP?.address || "",
    abhaRef: apiP?.abha_ref || "",
    abhaAddresses: extractAbhaAddresses(apiP),
    selectedAbhaAddress: undefined,
    mrn: apiP?.user_id ? String(apiP.user_id) : "",
  };
}

/* Build FHIR Patient with identifier.type.coding.display present */
function buildFhirPatient(form) {
  const id = form.resourceId && isUuid(form.resourceId) ? form.resourceId.toLowerCase() : uuidv4();
  const identifier = [];

  if (form.abhaRef) {
    identifier.push({
      system: "https://healthid.abdm.gov.in",
      value: String(form.abhaRef),
      type: {
        coding: [{ system: V2_0203, code: "PI", display: "Patient internal identifier" }],
        text: "ABHA Number",
      },
    });
  }

  if (form.selectedAbhaAddress) {
    identifier.push({
      system: "https://healthid.abdm.gov.in/address",
      value: String(form.selectedAbhaAddress),
      type: {
        coding: [{ system: V2_0203, code: "PN", display: "Person number" }],
        text: "ABHA Address",
      },
    });
  }

  if (form.mrn) {
    identifier.push({
      system: "http://hospital.example/mrn",
      value: String(form.mrn),
      type: {
        coding: [{ system: V2_0203, code: "MR", display: "Medical record number" }],
        text: "MRN",
      },
    });
  }

  if (!identifier.length) {
    identifier.push({
      system: "urn:uuid",
      value: id,
      type: {
        coding: [{ system: V2_0203, code: "PI", display: "Patient internal identifier" }],
        text: "generated-id",
      },
    });
  }

  const telecom = form.mobile ? [{ system: "phone", value: String(form.mobile) }] : [];

  return {
    resourceType: "Patient",
    id,
    meta: { profile: [NDHM_PATIENT_PROFILE] },
    text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${form.displayName}</p></div>` },
    identifier,
    name: [{ text: form.displayName }],
    gender: form.gender || undefined,
    birthDate: form.birthDate || undefined,
    telecom,
    address: form.address ? [{ text: form.address }] : [],
  };
}

/* Build Practitioner resource (single, generated id) */
function buildPractitioner(pract) {
  const id = uuidv4();
  return {
    resourceType: "Practitioner",
    id,
    meta: { profile: [NDHM_PRACTITIONER_PROFILE] },
    text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${pract.name}</p></div>` },
    identifier: [
      {
        system: "https://ndhm.in/practitioner/license",
        value: String(pract.license || ""),
        type: { coding: [{ system: V2_0203, code: "MD", display: "Medical License number" }], text: "Medical License number" },
      },
      {
        system: "https://your.system/login-id",
        value: String(pract.loginId || ""),
        type: { coding: [{ system: V2_0203, code: "PN", display: "Person number" }], text: "Login id" },
      },
    ],
    name: [{ text: pract.name }],
  };
}

/* Chosen, validator-friendly code slices:
   - Physical activity: LOINC 68516-4 (in NDHM PA value set)
   - General assessment: LOINC 8693-4 (present in NDHM general-assessment value set)
   - Lifestyle example: SNOMED 229819007 ("Tobacco use and exposure")
   These choices were made to satisfy NDHM slicing (LOINC or SNOMED) and to avoid display mismatches.
   (References: NDHM IG pages + LOINC pages.) */

function buildPhysicalActivityObs(patientId, practitionerId, text) {
  const id = uuidv4();
  return {
    resourceType: "Observation",
    id,
    meta: { profile: [OBS_PHYSICAL_PROFILE] },
    status: "final",
    // LOINC slice (system must be http://loinc.org to match NDHM profile slicing)
    code: {
      coding: [
        {
          system: "http://loinc.org",
          code: "68516-4",
          display: "On those days that you engage in moderate to strenuous exercise, how many minutes, on average, do you exercise",
        },
      ],
      text: "Physical activity",
    },
    subject: { reference: `urn:uuid:${patientId}` },
    performer: [{ reference: `urn:uuid:${practitionerId}` }],
    effectiveDateTime: new Date().toISOString(),
    // NDHM profile allows string for physical activity -> use valueString
    valueString: text || "Not provided",
    text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${text || "Not provided"}</p></div>` },
  };
}

function buildGeneralAssessmentObs(patientId, practitionerId, notes, pain) {
  const id = uuidv4();
  const textVal = notes || "Not provided";
  return {
    resourceType: "Observation",
    id,
    meta: { profile: [OBS_GENERAL_PROFILE] },
    status: "final",
    // choose a LOINC code that is present in NDHM general assessment value set (example: 8693-4)
    code: {
      coding: [
        { system: "http://loinc.org", code: "8693-4", display: "Mental status" },
      ],
      text: "General assessment",
    },
    subject: { reference: `urn:uuid:${patientId}` },
    performer: [{ reference: `urn:uuid:${practitionerId}` }],
    effectiveDateTime: new Date().toISOString(),
    // NDHM allows CodeableConcept for general assessment -> put notes in text
    valueCodeableConcept: { text: textVal },
    component: [
      { code: { text: "Any current pain?" }, valueCodeableConcept: { text: pain ? "Yes" : "No" } },
    ],
    text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${textVal}</p></div>` },
  };
}

function buildLifestyleObs(patientId, practitionerId, label, value) {
  const id = uuidv4();
  const v = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value || "Not provided");
  // Example SNOMED code for Tobacco exposure (NDHM lifestyle accepts SNOMED)
  return {
    resourceType: "Observation",
    id,
    meta: { profile: [OBS_LIFESTYLE_PROFILE] },
    status: "final",
    code: {
      coding: [{ system: "http://snomed.info/sct", code: "229819007", display: "Tobacco use and exposure" }],
      text: label || "Lifestyle",
    },
    subject: { reference: `urn:uuid:${patientId}` },
    performer: [{ reference: `urn:uuid:${practitionerId}` }],
    effectiveDateTime: new Date().toISOString(),
    valueCodeableConcept: { text: v },
    text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${label}: ${v}</p></div>` },
  };
}

/* optional vitals (as Quantity) */
function buildVitalObservation(patientId, practitionerId, codeText, quantity, unit, loincCode) {
  if (quantity === "" || quantity === undefined || quantity === null) return null;
  const id = uuidv4();
  return {
    resourceType: "Observation",
    id,
    meta: { profile: [] },
    status: "final",
    code: loincCode ? { coding: [{ system: "http://loinc.org", code: loincCode, display: codeText }], text: codeText } : { text: codeText },
    subject: { reference: `urn:uuid:${patientId}` },
    performer: [{ reference: `urn:uuid:${practitionerId}` }],
    effectiveDateTime: new Date().toISOString(),
    valueQuantity: { value: Number(quantity), unit: unit || "", system: "http://unitsofmeasure.org", code: unit || "" },
    text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${codeText}: ${quantity} ${unit || ""}</p></div>` },
  };
}

/* React app */
export default function App() {
  const [apiPatients, setApiPatients] = useState([]);
  const [forms, setForms] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [form, setForm] = useState(null);

  const [practitioner, setPractitioner] = useState({ ...GLOBAL_PRACTITIONER });

  // Observations inputs
  const [physicalText, setPhysicalText] = useState("");
  const [generalNotes, setGeneralNotes] = useState("");
  const [generalPain, setGeneralPain] = useState(false);
  const [lifestyle, setLifestyle] = useState([{ label: "Smoking", value: false }]);

  // optional vitals/body
  const [vitals, setVitals] = useState({ hr: "", systolic: "", diastolic: "", temp: "", spo2: "" });
  const [body, setBody] = useState({ height: "", weight: "", bmi: "" });

  const [bundleJson, setBundleJson] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/patients.json", { cache: "no-store" });
        const data = await res.json();
        const arr = Array.isArray(data) ? data : data?.data ?? [];
        setApiPatients(arr);
        const mapped = arr.map(mapApiToForm);
        setForms(mapped);
        if (mapped.length > 0) {
          setSelectedIndex(0);
          setForm({ ...mapped[0], selectedAbhaAddress: (mapped[0].abhaAddresses && mapped[0].abhaAddresses[0]) || mapped[0].abhaRef || "" });
        }
      } catch (err) {
        console.error("Failed to load patients.json", err);
        setMessage("Failed to load patients.json — place the file in public/patients.json and reload.");
      }
    })();
  }, []);

  useEffect(() => {
    if (selectedIndex >= 0 && forms[selectedIndex]) {
      const f = forms[selectedIndex];
      setForm({ ...f, selectedAbhaAddress: (f.abhaAddresses && f.abhaAddresses[0]) || f.abhaRef || "" });
    }
  }, [selectedIndex, forms]);

  function updateFormField(field, value) {
    setForm((p) => ({ ...p, [field]: value }));
    setForms((prev) => {
      const copy = [...prev];
      if (selectedIndex >= 0 && selectedIndex < copy.length) copy[selectedIndex] = { ...copy[selectedIndex], [field]: value };
      return copy;
    });
  }

  function addLifestyle() {
    setLifestyle((s) => [...s, { label: "", value: "" }]);
  }
  function removeLifestyle(i) {
    setLifestyle((s) => (s.length > 1 ? s.filter((_, idx) => idx !== i) : s));
  }
  function updateLifestyle(i, field, val) {
    setLifestyle((s) => {
      const copy = [...s];
      copy[i] = { ...copy[i], [field]: val };
      return copy;
    });
  }

  function generateBundle() {
    setMessage("");
    setBundleJson("");

    if (!form) return setMessage("Please select a patient.");
    if (!form.selectedAbhaAddress && !form.abhaRef) return setMessage("Please select ABHA address.");
    if (!practitioner.name || !practitioner.license) return setMessage("Practitioner name and license required.");

    const patientRes = buildFhirPatient(form);
    const practitionerRes = buildPractitioner(practitioner);

    const observations = [];

    // vitals
    const hrObs = buildVitalObservation(patientRes.id, practitionerRes.id, "Heart rate", vitals.hr, "beats/min", "8867-4");
    if (hrObs) observations.push(hrObs);
    const bpSys = buildVitalObservation(patientRes.id, practitionerRes.id, "Systolic blood pressure", vitals.systolic, "mmHg", "8480-6");
    const bpDia = buildVitalObservation(patientRes.id, practitionerRes.id, "Diastolic blood pressure", vitals.diastolic, "mmHg", "8462-4");
    if (bpSys) observations.push(bpSys);
    if (bpDia) observations.push(bpDia);
    if (vitals.temp) observations.push(buildVitalObservation(patientRes.id, practitionerRes.id, "Body temperature", vitals.temp, "Cel", "8310-5"));
    if (vitals.spo2) observations.push(buildVitalObservation(patientRes.id, practitionerRes.id, "SpO2", vitals.spo2, "%", "59408-5"));

    // body
    if (body.height) observations.push(buildVitalObservation(patientRes.id, practitionerRes.id, "Height", body.height, "cm", "8302-2"));
    if (body.weight) observations.push(buildVitalObservation(patientRes.id, practitionerRes.id, "Weight", body.weight, "kg", "29463-7"));
    if (body.bmi) observations.push(buildVitalObservation(patientRes.id, practitionerRes.id, "BMI", body.bmi, "kg/m2", "39156-5"));

    // physical activity
    const physObs = buildPhysicalActivityObs(patientRes.id, practitionerRes.id, physicalText || "Not provided");
    observations.push(physObs);

    // general assessment
    const genObs = buildGeneralAssessmentObs(patientRes.id, practitionerRes.id, generalNotes || "Not provided", !!generalPain);
    observations.push(genObs);

    // lifestyle repeatable
    for (const li of lifestyle) {
      if (!li.label && (li.value === "" || li.value === null || li.value === undefined)) continue;
      observations.push(buildLifestyleObs(patientRes.id, practitionerRes.id, li.label || "Lifestyle", li.value));
    }

    // composition sections: include entry arrays only when non-empty; otherwise include text object
    const compId = uuidv4();
    const sections = [];

    const vitalsEntries = observations.filter((o) => o.valueQuantity).map((o) => ({ reference: `urn:uuid:${o.id}` }));
    if (vitalsEntries.length) {
      sections.push({ title: "Vitals", entry: vitalsEntries });
    } else {
      sections.push({ title: "Vitals", text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">No vitals recorded</div>` } });
    }

    if (physObs) {
      sections.push({ title: "Physical Activity", entry: [{ reference: `urn:uuid:${physObs.id}` }], text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">Physical activity</div>` } });
    } else {
      sections.push({ title: "Physical Activity", text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">No physical activity recorded</div>` } });
    }

    if (genObs) {
      sections.push({ title: "General Assessment", entry: [{ reference: `urn:uuid:${genObs.id}` }], text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">General assessment</div>` } });
    } else {
      sections.push({ title: "General Assessment", text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">No general assessment recorded</div>` } });
    }

    const lifestyleEntries = observations.filter((o) => (o.meta?.profile || []).includes(OBS_LIFESTYLE_PROFILE)).map((o) => ({ reference: `urn:uuid:${o.id}` }));
    if (lifestyleEntries.length) {
      sections.push({ title: "Lifestyle", entry: lifestyleEntries, text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">Lifestyle</div>` } });
    } else {
      sections.push({ title: "Lifestyle", text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">No lifestyle observations recorded</div>` } });
    }

    const composition = {
      resourceType: "Composition",
      id: compId,
      meta: { profile: [NDHM_WELLNESS_COMPOSITION] },
      status: "final",
      type: { coding: [{ system: "http://loinc.org", code: "11502-2" }], text: "Wellness Record" },
      subject: { reference: `urn:uuid:${patientRes.id}`, display: form.displayName },
      date: new Date().toISOString(),
      author: [{ reference: `urn:uuid:${practitionerRes.id}`, display: practitioner.name }],
      attester: [{ mode: "official", party: { reference: `urn:uuid:${practitionerRes.id}` } }],
      title: "Wellness Record",
      section: sections,
      text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><h3>Wellness Record - ${form.displayName}</h3></div>` },
    };

    const bundle = {
      resourceType: "Bundle",
      type: "document",
      id: uuidv4(),
      identifier: { system: "https://nrces.in/ids/bundles", value: uuidv4() },
      timestamp: new Date().toISOString(),
      entry: [],
    };

    // composition first
    bundle.entry.push({ fullUrl: `urn:uuid:${composition.id}`, resource: composition });
    // patient and practitioner
    bundle.entry.push({ fullUrl: `urn:uuid:${patientRes.id}`, resource: patientRes });
    bundle.entry.push({ fullUrl: `urn:uuid:${practitionerRes.id}`, resource: practitionerRes });
    // observations
    for (const o of observations) bundle.entry.push({ fullUrl: `urn:uuid:${o.id}`, resource: o });

    setBundleJson(JSON.stringify(bundle, null, 2));
    setMessage("Bundle generated — copy-paste into Inferno/validator. If any remaining validation errors appear, paste them and I'll patch them exactly.");
    setTimeout(() => {
      const el = document.getElementById("bundlePreview");
      if (el) el.scrollIntoView({ behavior: "smooth" });
    }, 80);
  }

  function copyBundle() {
    if (!bundleJson) return;
    navigator.clipboard.writeText(bundleJson).then(() => alert("Copied bundle JSON to clipboard"));
  }

  return (
    <div className="container my-4">
      <h3>Wellness Record Builder — corrected</h3>
      <p className="text-muted">Bootstrap UI. Select patient → choose ABHA address → edit → Generate FHIR Bundle</p>

      <div className="card mb-3">
        <div className="card-header">Patient</div>
        <div className="card-body">
          <div className="mb-3">
            <label className="form-label">Select patient *</label>
            <select className="form-select" value={selectedIndex} onChange={(e) => setSelectedIndex(Number(e.target.value))}>
              {forms.length === 0 && <option value={-1}>No patients loaded</option>}
              {forms.map((f, i) => (
                <option key={i} value={i}>
                  {f.displayName || "Unknown"} — {f.gender || "unknown"} — {f.birthDate || "dob"} {f.abhaRef ? `— ${f.abhaRef}` : ""}
                </option>
              ))}
            </select>
          </div>

          {form && (
            <div className="row g-2">
              <div className="col-md-6">
                <label className="form-label">Name *</label>
                <input className="form-control" value={form.displayName} onChange={(e) => updateFormField("displayName", e.target.value)} />
              </div>

              <div className="col-md-3">
                <label className="form-label">Gender</label>
                <select className="form-select" value={form.gender || ""} onChange={(e) => updateFormField("gender", e.target.value)}>
                  <option value="">--</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                  <option value="unknown">Unknown</option>
                </select>
              </div>

              <div className="col-md-3">
                <label className="form-label">DOB</label>
                <input className="form-control" value={form.birthDate} onChange={(e) => updateFormField("birthDate", e.target.value)} placeholder="YYYY-MM-DD" />
              </div>

              <div className="col-md-4"><label className="form-label">Mobile</label><input className="form-control" value={form.mobile} onChange={(e) => updateFormField("mobile", e.target.value)} /></div>
              <div className="col-md-8"><label className="form-label">Address</label><input className="form-control" value={form.address} onChange={(e) => updateFormField("address", e.target.value)} /></div>

              <div className="col-md-6"><label className="form-label">ABHA Number</label><input className="form-control" value={form.abhaRef} onChange={(e) => updateFormField("abhaRef", e.target.value)} /></div>
              <div className="col-md-6"><label className="form-label">MRN</label><input className="form-control" value={form.mrn} onChange={(e) => updateFormField("mrn", e.target.value)} /></div>

              <div className="col-12">
                <label className="form-label">ABHA address (select) *</label>
                <select className="form-select" value={form.selectedAbhaAddress || ""} onChange={(e) => updateFormField("selectedAbhaAddress", e.target.value)}>
                  <option value="">-- select ABHA address --</option>
                  {(form.abhaAddresses && form.abhaAddresses.length > 0 ? form.abhaAddresses : (form.abhaRef ? [form.abhaRef] : [])).map((a, i) => (
                    <option key={i} value={a}>{a}</option>
                  ))}
                </select>
                <div className="form-text">Select one ABHA address. No remove option for ABHA addresses.</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Practitioner */}
      <div className="card mb-3">
        <div className="card-header">Practitioner (author/attester) *</div>
        <div className="card-body row g-2">
          <div className="col-md-8"><input className="form-control" value={practitioner.name} onChange={(e) => setPractitioner({ ...practitioner, name: e.target.value })} /></div>
          <div className="col-md-4"><input className="form-control" value={practitioner.license} onChange={(e) => setPractitioner({ ...practitioner, license: e.target.value })} /></div>
          <div className="col-12 mt-1"><small className="text-muted">Practitioner is included in bundle and used as author/attester/performer.</small></div>
        </div>
      </div>

      {/* Optional Vitals */}
      <div className="card mb-3">
        <div className="card-header">Vitals & Body (optional)</div>
        <div className="card-body">
          <div className="row g-2">
            <div className="col-md-2"><input className="form-control" placeholder="HR" value={vitals.hr} onChange={(e) => setVitals({ ...vitals, hr: e.target.value })} /></div>
            <div className="col-md-2"><input className="form-control" placeholder="Systolic" value={vitals.systolic} onChange={(e) => setVitals({ ...vitals, systolic: e.target.value })} /></div>
            <div className="col-md-2"><input className="form-control" placeholder="Diastolic" value={vitals.diastolic} onChange={(e) => setVitals({ ...vitals, diastolic: e.target.value })} /></div>
            <div className="col-md-2"><input className="form-control" placeholder="Temp °C" value={vitals.temp} onChange={(e) => setVitals({ ...vitals, temp: e.target.value })} /></div>
            <div className="col-md-2"><input className="form-control" placeholder="SpO2 %" value={vitals.spo2} onChange={(e) => setVitals({ ...vitals, spo2: e.target.value })} /></div>

            <div className="col-md-3"><input className="form-control" placeholder="Height cm" value={body.height} onChange={(e) => setBody({ ...body, height: e.target.value })} /></div>
            <div className="col-md-3"><input className="form-control" placeholder="Weight kg" value={body.weight} onChange={(e) => setBody({ ...body, weight: e.target.value })} /></div>
            <div className="col-md-3"><input className="form-control" placeholder="BMI" value={body.bmi} onChange={(e) => setBody({ ...body, bmi: e.target.value })} /></div>
          </div>
        </div>
      </div>

      {/* Observations */}
      <div className="card mb-3">
        <div className="card-header">Physical Activity (single)</div>
        <div className="card-body"><textarea className="form-control" rows="3" value={physicalText} onChange={(e) => setPhysicalText(e.target.value)} placeholder="Summary" /></div>
      </div>

      <div className="card mb-3">
        <div className="card-header">General Assessment (single)</div>
        <div className="card-body">
          <textarea className="form-control mb-2" rows="3" value={generalNotes} onChange={(e) => setGeneralNotes(e.target.value)} placeholder="Notes" />
          <div className="form-check"><input className="form-check-input" id="pain" type="checkbox" checked={generalPain} onChange={(e) => setGeneralPain(e.target.checked)} /><label className="form-check-label" htmlFor="pain">Any current pain?</label></div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-header">Lifestyle (repeatable)</div>
        <div className="card-body">
          {lifestyle.map((r, i) => (
            <div className="d-flex gap-2 align-items-center mb-2" key={i}>
              <input className="form-control" placeholder="Label (e.g. Smoking)" value={r.label} onChange={(e) => updateLifestyle(i, "label", e.target.value)} />
              <input className="form-control" placeholder="Value (true/false or text)" value={typeof r.value === "boolean" ? (r.value ? "true" : "false") : r.value} onChange={(e) => {
                const v = e.target.value;
                if (v === "true" || v === "false") updateLifestyle(i, "value", v === "true");
                else updateLifestyle(i, "value", v);
              }} />
              <button className="btn btn-danger" onClick={() => removeLifestyle(i)} disabled={lifestyle.length <= 1}>Remove</button>
            </div>
          ))}
          <button className="btn btn-primary" onClick={addLifestyle}>Add lifestyle</button>
        </div>
      </div>

      <div className="mb-4">
        <button className="btn btn-success me-2" onClick={generateBundle}>Generate FHIR Bundle</button>
        <button className="btn btn-outline-secondary" onClick={() => { setBundleJson(""); setMessage(""); }}>Reset Preview</button>
      </div>

      {message && <div className="alert alert-warning">{message}</div>}

      {bundleJson && (
        <div id="bundlePreview" className="card mb-4">
          <div className="card-header d-flex justify-content-between align-items-center">
            <div>Generated FHIR Bundle</div>
            <div><button className="btn btn-sm btn-outline-primary" onClick={copyBundle}>Copy JSON</button></div>
          </div>
          <div className="card-body"><pre style={{ maxHeight: 520, overflow: "auto" }}>{bundleJson}</pre></div>
        </div>
      )}

      <div className="text-muted small">Notes: coding uses LOINC (http://loinc.org) or SNOMED (http://snomed.info/sct) to satisfy NDHM slicing; Composition sections include proper text objects when empty to obey cmp-1. If Inferno shows remaining messages, paste the exact validator output and I'll patch the bundle line-by-line.</div>
    </div>
  );
}
