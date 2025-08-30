// src/App.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import "bootstrap/dist/css/bootstrap.min.css";

/*
  Health Document Record (Prescription Record) builder
  - Patient fetched from /patients.json (public)
  - Practitioner from global PRACTITIONERS (no API)
  - ABHA addresses normalized and selectable
  - File upload: PDF / JPG / JPEG (multiple)
  - If no file uploaded, a small PDF placeholder base64 is used
  - Produces FHIR Bundle (document) containing:
      Composition (type: SNOMED 419891008 "Record artifact")
      Patient
      Practitioner
      (optional) Organization (custodian)
      DocumentReference(s) + Binary(s)
  - Bundle.identifier uses urn:ietf:rfc:3986 + urn:uuid:<uuid>
  - All XHTML narratives include lang & xml:lang to avoid validator warnings
  - UI is Bootstrap-based (cards + rows) consistent with your previous forms
*/

/* ----------------------------- GLOBAL DATA ------------------------------ */
/* Practitioners come from a global variable (no network call) */
const PRACTITIONERS = [
  { id: "prac-1", name: "Dr. A. Verma", qualification: "MBBS, MD", phone: "+919000011111", email: "verma@example.org", registration: { system: "https://nmc.org.in", value: "NMC-123" } },
  { id: "prac-2", name: "Dr. B. Rao", qualification: "MBBS, MS", phone: "+919000022222", email: "rao@example.org", registration: { system: "https://nmc.org.in", value: "NMC-456" } },
];

/* ------------------------------- HELPERS -------------------------------- */
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/* Convert dd-mm-yyyy (or dd/mm/yyyy) to yyyy-mm-dd, else return undefined */
function ddmmyyyyToISO(v) {
  if (!v) return undefined;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const sep = s.includes("-") ? "-" : s.includes("/") ? "/" : null;
  if (!sep) return undefined;
  const parts = s.split(sep);
  if (parts.length !== 3) return undefined;
  const [dd, mm, yyyy] = parts;
  if (!dd || !mm || !yyyy) return undefined;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/* Produce ISO datetime string with local timezone offset (e.g., 2025-08-30T15:04:05+05:30) */
function isoWithLocalOffsetFromDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  const pad = n => String(Math.abs(Math.floor(n))).padStart(2, "0");
  const tzo = -date.getTimezoneOffset();
  const sign = tzo >= 0 ? "+" : "-";
  const hh = pad(Math.floor(Math.abs(tzo) / 60));
  const mm = pad(Math.abs(tzo) % 60);
  // Build YYYY-MM-DDTHH:MM:SS+/-HH:MM
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    "T" +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes()) +
    ":" +
    pad(date.getSeconds()) +
    sign +
    hh +
    ":" +
    mm
  );
}

/* Convert 'datetime-local' input (YYYY-MM-DDTHH:MM) to iso-with-offset */
function localDatetimeToISOWithOffset(localDatetime) {
  if (!localDatetime) return isoWithLocalOffsetFromDate(new Date());
  // new Date(localDatetime) treats it as local time
  return isoWithLocalOffsetFromDate(new Date(localDatetime));
}

/* Narrative wrapper (XHTML) with lang & xml:lang (validator requirement) */
function buildNarrative(title, innerHtml) {
  return {
    status: "generated",
    div: `<div xmlns="http://www.w3.org/1999/xhtml" lang="en-IN" xml:lang="en-IN"><h3>${title}</h3>${innerHtml}</div>`,
  };
}

/* Read file into base64 (no "data:...," prefix) */
function fileToBase64NoPrefix(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("File read error"));
    reader.onload = () => {
      const res = reader.result || "";
      const idx = String(res).indexOf("base64,");
      if (idx >= 0) resolve(String(res).slice(idx + 7));
      else resolve(String(res));
    };
    reader.readAsDataURL(file);
  });
}

/* Small PDF header placeholder (short; validator-friendly) */
const PLACEHOLDER_PDF_B64 = "JVBERi0xLjQKJeLjz9MK";

/* Fixed SNOMED coding for Composition.type per your mapping */
const COMPOSITION_DOC_TYPE = { system: "http://snomed.info/sct", code: "419891008", display: "Record artifact" };

/* Normalize ABHA addresses (strings or objects with address/isPrimary) */
function normalizeAbhaAddresses(patientObj) {
  const raw =
    patientObj?.additional_attributes?.abha_addresses && Array.isArray(patientObj.additional_attributes.abha_addresses)
      ? patientObj.additional_attributes.abha_addresses
      : Array.isArray(patientObj?.abha_addresses)
      ? patientObj.abha_addresses
      : [];

  const out = raw
    .map(item => {
      if (!item) return null;
      if (typeof item === "string") return { value: item, label: item, primary: false };
      if (typeof item === "object") {
        if (item.address) return { value: String(item.address), label: item.isPrimary ? `${item.address} (primary)` : String(item.address), primary: !!item.isPrimary };
        try {
          const v = JSON.stringify(item);
          return { value: v, label: v, primary: !!item.isPrimary };
        } catch { return null; }
      }
      return null;
    })
    .filter(Boolean);
  out.sort((a, b) => (b.primary - a.primary) || a.value.localeCompare(b.value));
  return out;
}

/* ------------------------------- APP ------------------------------------- */

export default function App() {
  /* Patients (from /patients.json) */
  const [patients, setPatients] = useState([]);
  const [selectedPatientIdx, setSelectedPatientIdx] = useState(-1);
  const selectedPatient = useMemo(() => (selectedPatientIdx >= 0 ? patients[selectedPatientIdx] : null), [patients, selectedPatientIdx]);

  /* ABHA addresses */
  const [abhaOptions, setAbhaOptions] = useState([]);
  const [selectedAbha, setSelectedAbha] = useState("");

  /* Practitioner (global; no API fetch) */
  const [selectedPractitionerIdx, setSelectedPractitionerIdx] = useState(0);

  /* Composition fields */
  const [status, setStatus] = useState("final"); // preliminary | final | amended | entered-in-error
  const [title, setTitle] = useState("Prescription Record"); // required
  const [dateTimeLocal, setDateTimeLocal] = useState(() => {
    // default to now in local datetime-local format: YYYY-MM-DDTHH:MM
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  /* Optional fields */
  const [encounterRefText, setEncounterRefText] = useState(""); // free text for Encounter reference (optional)
  const [custodianName, setCustodianName] = useState(""); // optional Organization name (custodian)
  const [attesterMode, setAttesterMode] = useState("professional"); // personal | professional | legal | official
  const [attesterPartyType, setAttesterPartyType] = useState("Practitioner"); // Practitioner | Organization
  const [attesterOrgName, setAttesterOrgName] = useState(""); // if attester is Organization; optional

  /* Document uploads (multiple) */
  const fileInputRef = useRef(null);
  const [files, setFiles] = useState([]); // array of File objects
  const [fileNamesPreview, setFileNamesPreview] = useState([]);

  /* Output JSON */
  const [jsonOut, setJsonOut] = useState("");

  /* Load patients on mount */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/patients.json");
        const data = await res.json();
        const arr = Array.isArray(data) ? data : [];
        setPatients(arr);
        if (arr.length > 0) {
          setSelectedPatientIdx(0);
          const norm = normalizeAbhaAddresses(arr[0]);
          setAbhaOptions(norm);
          setSelectedAbha(norm.length ? norm[0].value : "");
        }
      } catch (e) {
        console.error("Failed loading /patients.json", e);
      }
    })();
  }, []);

  /* When selected patient changes, update ABHA options */
  useEffect(() => {
    if (!selectedPatient) {
      setAbhaOptions([]);
      setSelectedAbha("");
      return;
    }
    const norm = normalizeAbhaAddresses(selectedPatient);
    setAbhaOptions(norm);
    setSelectedAbha(norm.length ? norm[0].value : "");
  }, [selectedPatientIdx]); // eslint-disable-line

  /* Handle file pick (multiple allowed) */
  function onFilesPicked(e) {
    const list = e.target.files ? Array.from(e.target.files) : [];
    setFiles(list);
    setFileNamesPreview(list.map(f => f.name));
  }

  /* Remove a selected file from the UI before building */
  function removeFileAtIndex(i) {
    setFiles(prev => prev.filter((_, idx) => idx !== i));
    setFileNamesPreview(prev => prev.filter((_, idx) => idx !== i));
    if (fileInputRef.current) {
      // reset input so same files can be reselected later if needed
      fileInputRef.current.value = "";
    }
  }

  /* --------------------------- Build FHIR Bundle --------------------------- */
  async function onBuildBundle() {
    // Basic validation for required fields
    if (!selectedPatient) {
      alert("Please select a patient (required).");
      return;
    }
    if (!title || !title.trim()) {
      alert("Title is required.");
      return;
    }
    if (!status) {
      alert("Status is required.");
      return;
    }
    if (selectedPractitionerIdx == null) {
      alert("Select a practitioner (author).");
      return;
    }

    const authoredOn = localDatetimeToISOWithOffset(dateTimeLocal);

    // Generate ids for resources
    const compId = uuidv4();
    const patientId = uuidv4();
    const practitionerId = uuidv4();
    const encounterId = encounterRefText ? uuidv4() : null;
    const custodianOrgId = custodianName ? uuidv4() : null;
    const attesterOrgId = attesterPartyType === "Organization" && attesterOrgName ? uuidv4() : null;

    // Prepare DocumentReference & Binary resources (one per uploaded file; if none, create single placeholder)
    const docsToProcess = files.length > 0 ? files : [null]; // null indicates placeholder
    const binaryIds = docsToProcess.map(() => uuidv4());
    const docRefIds = docsToProcess.map(() => uuidv4());

    // Build Patient resource
    function buildPatientResource() {
      const p = selectedPatient;
      const identifiers = [];
      // prefer patient.mrn, user_ref_id, abha_ref, id as MRN-like identifier
      const mrn = p?.mrn || p?.user_ref_id || p?.abha_ref || p?.id;
      if (mrn) identifiers.push({ system: "https://healthid.ndhm.gov.in", value: String(mrn) });
      if (p?.abha_ref) identifiers.push({ system: "https://abdm.gov.in/abha", value: p.abha_ref });

      const telecom = [];
      if (p?.mobile) telecom.push({ system: "phone", value: p.mobile });
      if (p?.email) telecom.push({ system: "email", value: p.email });
      if (selectedAbha) telecom.push({ system: "url", value: `abha://${selectedAbha}` });

      return {
        resourceType: "Patient",
        id: patientId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Patient"] },
        text: buildNarrative("Patient", `<p>${p.name || ""}</p><p>${p.gender || ""} ${p.dob || ""}</p>`),
        identifier: identifiers,
        name: p.name ? [{ text: p.name }] : undefined,
        gender: p.gender ? String(p.gender).toLowerCase() : undefined,
        birthDate: ddmmyyyyToISO(p.dob) || undefined,
        telecom: telecom.length ? telecom : undefined,
        address: p?.address ? [{ text: p.address }] : undefined,
      };
    }

    // Build Practitioner resource (global list)
    function buildPractitionerResource() {
      const p = PRACTITIONERS[selectedPractitionerIdx] || PRACTITIONERS[0];
      return {
        resourceType: "Practitioner",
        id: practitionerId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Practitioner"] },
        text: buildNarrative("Practitioner", `<p>${p.name}</p><p>${p.qualification}</p>`),
        identifier: p.registration?.system && p.registration?.value ? [{ system: p.registration.system, value: p.registration.value }] : undefined,
        name: [{ text: p.name }],
        telecom: [
          p.phone ? { system: "phone", value: p.phone } : null,
          p.email ? { system: "email", value: p.email } : null,
        ].filter(Boolean),
      };
    }

    // Optional Organization resources (custodian / attesterOrg)
    function buildOrganizationResource(orgId, orgName) {
      if (!orgName) return null;
      return {
        resourceType: "Organization",
        id: orgId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Organization"] },
        text: buildNarrative("Organization", `<p>${orgName}</p>`),
        name: orgName,
      };
    }

    // Build Encounter resource if text provided (simple placeholder)
    function buildEncounterResource() {
      if (!encounterId) return null;
      const start = isoWithLocalOffsetFromDate(new Date());
      return {
        resourceType: "Encounter",
        id: encounterId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Encounter"] },
        text: buildNarrative("Encounter", `<p>${encounterRefText}</p>`),
        status: "finished",
        class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
        subject: { reference: `urn:uuid:${patientId}` },
        period: { start, end: start },
      };
    }

    // Build Binary + DocumentReference resources for each file (or placeholder)
    async function buildDocAndBinaryResources() {
      const binaries = [];
      const docRefs = [];

      for (let i = 0; i < docsToProcess.length; i++) {
        const f = docsToProcess[i];
        const binId = binaryIds[i];
        const docId = docRefIds[i];
        let contentType = "application/pdf";
        let dataB64 = PLACEHOLDER_PDF_B64;
        let title = "placeholder.pdf";

        if (f) {
          // real file
          contentType = f.type || "application/pdf";
          dataB64 = await fileToBase64NoPrefix(f);
          title = f.name || title;
        }

        const binary = {
          resourceType: "Binary",
          id: binId,
          language: "en-IN",
          meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Binary"] },
          contentType,
          data: dataB64,
        };

        const docRef = {
          resourceType: "DocumentReference",
          id: docId,
          language: "en-IN",
          meta: { profile: ["http://hl7.org/fhir/StructureDefinition/DocumentReference"] },
          text: buildNarrative("DocumentReference", `<p>${title}</p>`),
          status: "current",
          type: {
            coding: [{ system: "http://loinc.org", code: "34108-1", display: "Outpatient Note" }],
            text: "Outpatient Note",
          },
          subject: { reference: `urn:uuid:${patientId}` },
          date: authoredOn,
          content: [
            {
              attachment: {
                contentType,
                title,
                url: `urn:uuid:${binId}`, // points to Binary entry in same bundle
              },
            },
          ],
        };

        binaries.push(binary);
        docRefs.push(docRef);
      }

      return { binaries, docRefs };
    }

    // Build Composition resource referencing DocumentReference entries
    function buildCompositionResource(docRefs) {
      const sectionEntries = docRefs.map(dr => ({ reference: `urn:uuid:${dr.id}`, type: "DocumentReference" }));
      const attesterArr = [];

      // attester structure if provided (optional)
      if (attesterPartyType === "Practitioner") {
        // refer to same practitioner resource
        attesterArr.push({ mode: attesterMode, party: { reference: `urn:uuid:${practitionerId}` } });
      } else if (attesterPartyType === "Organization" && attesterOrgId) {
        attesterArr.push({ mode: attesterMode, party: { reference: `urn:uuid:${attesterOrgId}` } });
      }

      const composition = {
        resourceType: "Composition",
        id: compId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Composition"] },
        text: buildNarrative("Composition", `<p>${title}</p><p>Author: ${PRACTITIONERS[selectedPractitionerIdx]?.name || ""}</p>`),
        status: status,
        type: { coding: [COMPOSITION_DOC_TYPE], text: "Record artifact" }, // fixed per mapping
        subject: { reference: `urn:uuid:${patientId}` },
        // encounter optional
        ...(encounterId ? { encounter: { reference: `urn:uuid:${encounterId}` } } : {}),
        date: authoredOn,
        author: [{ reference: `urn:uuid:${practitionerId}`, display: PRACTITIONERS[selectedPractitionerIdx]?.name }],
        title: title,
        ...(attesterArr.length ? { attester: attesterArr } : {}),
        ...(custodianOrgId ? { custodian: { reference: `urn:uuid:${custodianOrgId}` } } : {}),
        section: [
          {
            // The section is mandatory (1..1) and code fixed as mapping (same SNOMED)
            title: "Health documents",
            code: { coding: [COMPOSITION_DOC_TYPE], text: "Record artifact" },
            entry: sectionEntries,
          },
        ],
      };

      return composition;
    }

    // Build the resources
    const patientRes = buildPatientResource();
    const practitionerRes = buildPractitionerResource();
    const encounterRes = buildEncounterResource();
    const custodianRes = custodianOrgId ? buildOrganizationResource(custodianOrgId, custodianName) : null;
    const attesterOrgRes = attesterOrgId ? buildOrganizationResource(attesterOrgId, attesterOrgName) : null;

    const { binaries, docRefs } = await buildDocAndBinaryResources();
    const compositionRes = buildCompositionResource(docRefs);

    // Build Bundle; Composition must be first entry so forward traversal from Composition works
    const bundleId = `HealthDocumentBundle-${uuidv4()}`;
    const bundle = {
      resourceType: "Bundle",
      id: bundleId,
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Bundle"], lastUpdated: isoWithLocalOffsetFromDate(new Date()) },
      identifier: { system: "urn:ietf:rfc:3986", value: `urn:uuid:${uuidv4()}` },
      type: "document",
      timestamp: isoWithLocalOffsetFromDate(new Date()),
      entry: [
        { fullUrl: `urn:uuid:${compositionRes.id}`, resource: compositionRes },
        { fullUrl: `urn:uuid:${patientRes.id}`, resource: patientRes },
        { fullUrl: `urn:uuid:${practitionerRes.id}`, resource: practitionerRes },
      ],
    };

    // Optional resources appended after composition + patient + practitioner
    if (encounterRes) bundle.entry.push({ fullUrl: `urn:uuid:${encounterRes.id}`, resource: encounterRes });
    if (custodianRes) bundle.entry.push({ fullUrl: `urn:uuid:${custodianRes.id}`, resource: custodianRes });
    if (attesterOrgRes) bundle.entry.push({ fullUrl: `urn:uuid:${attesterOrgRes.id}`, resource: attesterOrgRes });

    // Append DocumentReference and Binary entries
    docRefs.forEach((dr, i) => {
      bundle.entry.push({ fullUrl: `urn:uuid:${dr.id}`, resource: dr });
    });
    binaries.forEach(b => {
      bundle.entry.push({ fullUrl: `urn:uuid:${b.id}`, resource: b });
    });

    // Set output
    setJsonOut(JSON.stringify(bundle, null, 2));
    console.log("Generated Health Document Bundle:", bundle);
    alert("Bundle generated and logged to console. Paste JSON into your validator.");
  }

  /* ------------------------------- RENDER UI -------------------------------- */
  return (
    <div className="container py-4">
      <h2 className="mb-3">Health Document Record — Builder</h2>

      {/* 1. Patient */}
      <div className="card mb-3">
        <div className="card-header">1. Patient <span className="text-danger">*</span></div>
        <div className="card-body">
          <div className="row g-3 mb-2">
            <div className="col-md-8">
              <label className="form-label">Select Patient</label>
              <select className="form-select" value={selectedPatientIdx} onChange={e => setSelectedPatientIdx(Number(e.target.value))}>
                {patients.map((p, i) => (
                  <option key={p.id || i} value={i}>{p.name} {p.abha_ref ? `(${p.abha_ref})` : ""}</option>
                ))}
              </select>
            </div>

            <div className="col-md-4">
              <label className="form-label">ABHA Address (pick)</label>
              <select className="form-select" value={selectedAbha} onChange={e => setSelectedAbha(e.target.value)} disabled={!abhaOptions.length}>
                {abhaOptions.length === 0 ? <option value="">No ABHA addresses</option> : abhaOptions.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
          </div>

          {selectedPatient && (
            <div className="row g-3">
              <div className="col-md-6">
                <label className="form-label">Name</label>
                <input className="form-control" readOnly value={selectedPatient.name || ""} />
              </div>
              <div className="col-md-2">
                <label className="form-label">Gender</label>
                <input className="form-control" readOnly value={selectedPatient.gender || ""} />
              </div>
              <div className="col-md-2">
                <label className="form-label">DOB</label>
                <input className="form-control" readOnly value={selectedPatient.dob || ""} />
              </div>
              <div className="col-md-2">
                <label className="form-label">Mobile</label>
                <input className="form-control" readOnly value={selectedPatient.mobile || ""} />
              </div>

              <div className="col-12">
                <label className="form-label">Address</label>
                <textarea className="form-control" rows={2} readOnly value={selectedPatient.address || ""} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 2. Practitioner (global) */}
      <div className="card mb-3">
        <div className="card-header">2. Author / Practitioner <span className="text-danger">*</span></div>
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-6">
              <label className="form-label">Select Practitioner</label>
              <select className="form-select" value={selectedPractitionerIdx} onChange={e => setSelectedPractitionerIdx(Number(e.target.value))}>
                {PRACTITIONERS.map((p, i) => <option key={p.id} value={i}>{p.name} ({p.qualification})</option>)}
              </select>
            </div>
            <div className="col-md-6">
              <label className="form-label">Practitioner (read-only)</label>
              <input className="form-control" readOnly value={PRACTITIONERS[selectedPractitionerIdx]?.name || ""} />
            </div>
          </div>
        </div>
      </div>

      {/* 3. Composition metadata */}
      <div className="card mb-3">
        <div className="card-header">3. Composition Metadata</div>
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-3">
              <label className="form-label">Status <span className="text-danger">*</span></label>
              <select className="form-select" value={status} onChange={e => setStatus(e.target.value)}>
                <option value="preliminary">preliminary</option>
                <option value="final">final</option>
                <option value="amended">amended</option>
                <option value="entered-in-error">entered-in-error</option>
              </select>
            </div>

            <div className="col-md-6">
              <label className="form-label">Title <span className="text-danger">*</span></label>
              <input className="form-control" value={title} onChange={e => setTitle(e.target.value)} />
            </div>

            <div className="col-md-3">
              <label className="form-label">Date/Time <span className="text-danger">*</span></label>
              <input type="datetime-local" className="form-control" value={dateTimeLocal} onChange={e => setDateTimeLocal(e.target.value)} />
            </div>

            <div className="col-md-6">
              <label className="form-label">Encounter (optional)</label>
              <input className="form-control" placeholder="Encounter reference (optional free text)" value={encounterRefText} onChange={e => setEncounterRefText(e.target.value)} />
            </div>

            <div className="col-md-6">
              <label className="form-label">Custodian (Organization) (optional)</label>
              <input className="form-control" placeholder="Organization name (optional)" value={custodianName} onChange={e => setCustodianName(e.target.value)} />
            </div>
          </div>
        </div>
      </div>

      {/* 4. Attester (optional) */}
      <div className="card mb-3">
        <div className="card-header">4. Attester (optional)</div>
        <div className="card-body">
          <div className="row g-3 align-items-end">
            <div className="col-md-3">
              <label className="form-label">Mode</label>
              <select className="form-select" value={attesterMode} onChange={e => setAttesterMode(e.target.value)}>
                <option value="personal">personal</option>
                <option value="professional">professional</option>
                <option value="legal">legal</option>
                <option value="official">official</option>
              </select>
            </div>

            <div className="col-md-3">
              <label className="form-label">Party type</label>
              <select className="form-select" value={attesterPartyType} onChange={e => setAttesterPartyType(e.target.value)}>
                <option value="Practitioner">Practitioner</option>
                <option value="Organization">Organization</option>
              </select>
            </div>

            {attesterPartyType === "Organization" && (
              <div className="col-md-6">
                <label className="form-label">Attester Organization name</label>
                <input className="form-control" value={attesterOrgName} onChange={e => setAttesterOrgName(e.target.value)} placeholder="Organization name (optional)" />
              </div>
            )}
            {attesterPartyType === "Practitioner" && (
              <div className="col-md-6">
                <label className="form-label">Attester Practitioner</label>
                <select className="form-select" value={selectedPractitionerIdx} onChange={e => setSelectedPractitionerIdx(Number(e.target.value))}>
                  {PRACTITIONERS.map((p, i) => <option key={p.id} value={i}>{p.name}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 5. Documents (section: entries must be DocumentReference) */}
      <div className="card mb-3">
        <div className="card-header">5. Documents (one or more) <span className="text-danger">*</span></div>
        <div className="card-body">
          <div className="mb-2">
            <label className="form-label">Upload PDF / JPG / JPEG (multiple allowed)</label>
            <input ref={fileInputRef} type="file" accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg" multiple onChange={onFilesPicked} />
          </div>
          <div>
            {fileNamesPreview.length === 0 ? <div className="text-muted">No files selected — a placeholder PDF will be embedded automatically.</div> : (
              <ul className="list-group">
                {fileNamesPreview.map((n, i) => (
                  <li className="list-group-item d-flex justify-content-between align-items-center" key={i}>
                    {n}
                    <button className="btn btn-sm btn-danger" onClick={() => removeFileAtIndex(i)}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="mb-4">
        <button className="btn btn-primary" onClick={onBuildBundle}>Generate Health Document Bundle & Log</button>
      </div>

      {/* Output */}
      <div className="card mb-5">
        <div className="card-header">Output JSON (Bundle)</div>
        <div className="card-body">
          <textarea className="form-control" rows={16} value={jsonOut} onChange={e => setJsonOut(e.target.value)} />
          <small className="text-muted">Copy the JSON and validate with your FHIR validator (Inferno / other).</small>
        </div>
      </div>
    </div>
  );
}
