// src/App.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import "bootstrap/dist/css/bootstrap.min.css";

/*
  Immunization Record Builder (plain JS, single-file)
  - Patient: fetched from /patients.json (public)
  - Practitioner: global PRACTITIONERS (no API)
  - Add/Remove Immunizations (each becomes Immunization resource)
  - Optional ImmunizationRecommendation
  - Upload DocumentReference files (PDF/JPEG/JPG)
  - Produces FHIR Bundle (document) with Composition (SNOMED 41000179103)
*/

/* --------------------------- GLOBAL PRACTITIONERS --------------------------- */
const PRACTITIONERS = [
  { id: "prac-1", name: "Dr. A. Verma", qualification: "MBBS, MD", phone: "+919000011111", email: "verma@example.org", registration: { system: "https://nmc.org.in", value: "NMC-123" } },
  { id: "prac-2", name: "Dr. B. Rao", qualification: "MBBS, MS", phone: "+919000022222", email: "rao@example.org", registration: { system: "https://nmc.org.in", value: "NMC-456" } },
];

/* ------------------------------- UTILITIES --------------------------------- */
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function ddmmyyyyToISO(v) {
  if (!v) return undefined;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const sep = s.includes("-") ? "-" : s.includes("/") ? "/" : null;
  if (!sep) return undefined;
  const parts = s.split(sep);
  if (parts.length !== 3) return undefined;
  const [dd, mm, yyyy] = parts;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function isoWithLocalOffsetFromDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  const pad = n => String(Math.abs(Math.floor(n))).padStart(2, "0");
  const tzo = -date.getTimezoneOffset();
  const sign = tzo >= 0 ? "+" : "-";
  const hh = pad(Math.floor(Math.abs(tzo) / 60));
  const mm = pad(Math.abs(tzo) % 60);
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

function localDatetimeToISOWithOffset(localDatetime) {
  if (!localDatetime) return isoWithLocalOffsetFromDate(new Date());
  return isoWithLocalOffsetFromDate(new Date(localDatetime));
}

function buildNarrative(title, innerHtml) {
  return {
    status: "generated",
    div: `<div xmlns="http://www.w3.org/1999/xhtml" lang="en-IN" xml:lang="en-IN"><h3>${title}</h3>${innerHtml}</div>`,
  };
}

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

/* tiny placeholder PDF header if no files uploaded */
const PLACEHOLDER_PDF_B64 = "JVBERi0xLjQKJeLjz9MK";

/* Fixed SNOMED coding for Composition.type and section code */
const SNOMED_IMM_RECORD = { system: "http://snomed.info/sct", code: "41000179103", display: "Immunization record" };

/* Normalize ABHA addresses (strings or objects) */
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

/* ------------------------------- APP -------------------------------------- */

export default function App() {
  /* patients + selection */
  const [patients, setPatients] = useState([]);
  const [selectedPatientIdx, setSelectedPatientIdx] = useState(-1);
  const selectedPatient = useMemo(() => (selectedPatientIdx >= 0 ? patients[selectedPatientIdx] : null), [patients, selectedPatientIdx]);

  /* abha list */
  const [abhaOptions, setAbhaOptions] = useState([]);
  const [selectedAbha, setSelectedAbha] = useState("");

  /* practitioner (global) */
  const [selectedPractitionerIdx, setSelectedPractitionerIdx] = useState(0);

  /* composition meta */
  const [status, setStatus] = useState("final");
  const [title, setTitle] = useState("Immunization Record");
  const [dateTimeLocal, setDateTimeLocal] = useState(() => {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  /* optional fields */
  const [encounterText, setEncounterText] = useState("");
  const [custodianName, setCustodianName] = useState("");

  /* immunizations list (each: vaccineText, date, status, lotNumber) */
  const [immunizations, setImmunizations] = useState([
    { vaccineText: "BCG", occurrenceDate: "", status: "completed", lotNumber: "" },
  ]);

  function addImmunization() {
    setImmunizations(prev => [...prev, { vaccineText: "", occurrenceDate: "", status: "completed", lotNumber: "" }]);
  }
  function updateImmunization(i, key, val) {
    setImmunizations(prev => prev.map((m, idx) => (idx === i ? { ...m, [key]: val } : m)));
  }
  function removeImmunization(i) {
    setImmunizations(prev => prev.filter((_, idx) => idx !== i));
  }

  /* optional immunization recommendation */
  const [immRecText, setImmRecText] = useState("");
  const [immRecDateLocal, setImmRecDateLocal] = useState("");

  /* Document uploads */
  const fileInputRef = useRef(null);
  const [files, setFiles] = useState([]); // File[]
  const [filePreviewNames, setFilePreviewNames] = useState([]);

  function onFilesPicked(e) {
    const list = e.target.files ? Array.from(e.target.files) : [];
    setFiles(list);
    setFilePreviewNames(list.map(f => f.name));
  }

  function removeFileAtIndex(i) {
    setFiles(prev => prev.filter((_, idx) => idx !== i));
    setFilePreviewNames(prev => prev.filter((_, idx) => idx !== i));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /* output */
  const [jsonOut, setJsonOut] = useState("");

  /* load patients */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/patients.json");
        const data = await res.json();
        const arr = Array.isArray(data) ? data : [];
        setPatients(arr);
        if (arr.length > 0) {
          setSelectedPatientIdx(0);
          const abhas = normalizeAbhaAddresses(arr[0]);
          setAbhaOptions(abhas);
          setSelectedAbha(abhas.length ? abhas[0].value : "");
        }
      } catch (e) {
        console.error("Failed to load patients.json", e);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedPatient) {
      setAbhaOptions([]);
      setSelectedAbha("");
      return;
    }
    const abhas = normalizeAbhaAddresses(selectedPatient);
    setAbhaOptions(abhas);
    setSelectedAbha(abhas.length ? abhas[0].value : "");
  }, [selectedPatientIdx]); // eslint-disable-line

  /* Validation before generating */
  function validateBeforeBuild() {
    const errors = [];
    if (!selectedPatient) errors.push("Select a patient (required).");
    if (!status) errors.push("Status is required.");
    if (!title || !title.trim()) errors.push("Title is required.");
    // section entries: at least one immunization OR immRec OR document
    const hasImms = immunizations && immunizations.length > 0 && immunizations.some(i => i.vaccineText && i.vaccineText.trim());
    const hasImmRec = immRecText && immRecText.trim();
    const hasDocs = files && files.length > 0;
    if (!(hasImms || hasImmRec || hasDocs)) errors.push("Add at least one immunization, or an immunization recommendation, or upload at least one document.");
    return errors;
  }

  /* ---------------------- Build FHIR Bundle (async) ------------------------ */
  async function onBuildBundle() {
    const errors = validateBeforeBuild();
    if (errors.length) {
      alert("Please fix:\n" + errors.join("\n"));
      return;
    }

    const authoredOn = localDatetimeToISOWithOffset(dateTimeLocal);

    // ids
    const compId = uuidv4();
    const patientId = uuidv4();
    const practitionerId = uuidv4();
    const encounterId = encounterText ? uuidv4() : null;
    const custodianId = custodianName ? uuidv4() : null;

    const immIds = immunizations.map(() => uuidv4());
    const immRecId = immRecText ? uuidv4() : null;
    const docBinaryIds = (files.length ? files : [null]).map(() => uuidv4());
    const docRefIds = docBinaryIds.map(() => uuidv4());

    // Patient resource
    function buildPatientResource() {
      const p = selectedPatient;
      const identifiers = [];
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
        identifier: identifiers.length ? identifiers : undefined,
        name: p.name ? [{ text: p.name }] : undefined,
        gender: p.gender ? String(p.gender).toLowerCase() : undefined,
        birthDate: ddmmyyyyToISO(p.dob) || undefined,
        telecom: telecom.length ? telecom : undefined,
        address: p?.address ? [{ text: p.address }] : undefined,
      };
    }

    // Practitioner resource (global)
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

    function buildEncounterResource() {
      if (!encounterId) return null;
      const start = isoWithLocalOffsetFromDate(new Date());
      return {
        resourceType: "Encounter",
        id: encounterId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Encounter"] },
        text: buildNarrative("Encounter", `<p>${encounterText}</p>`),
        status: "finished",
        class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
        subject: { reference: `urn:uuid:${patientId}` },
        period: { start, end: start },
      };
    }

    function buildCustodianOrg() {
      if (!custodianId) return null;
      return {
        resourceType: "Organization",
        id: custodianId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Organization"] },
        text: buildNarrative("Organization", `<p>${custodianName}</p>`),
        name: custodianName,
      };
    }

    // Build Immunization resources from immunizations[] entries
    function buildImmunizationResources() {
      return immunizations.map((m, idx) => {
        const id = immIds[idx];
        const occ = m.occurrenceDate ? (m.occurrenceDate.includes("T") ? new Date(m.occurrenceDate).toISOString() : ddmmyyyyToISO(m.occurrenceDate) || new Date().toISOString()) : new Date().toISOString();
        return {
          resourceType: "Immunization",
          id,
          language: "en-IN",
          meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Immunization"] },
          text: buildNarrative("Immunization", `Vaccine: ${m.vaccineText || "Unknown"}, Date: ${occ}`),
          status: m.status || "completed",
          vaccineCode: { text: m.vaccineText || "Unknown vaccine" },
          patient: { reference: `urn:uuid:${patientId}` },
          occurrenceDateTime: occ,
          lotNumber: m.lotNumber || undefined,
        };
      });
    }

    // Build ImmunizationRecommendation (optional) resource
    function buildImmRecResource() {
      if (!immRecId) return null;
      const rr = {
        resourceType: "ImmunizationRecommendation",
        id: immRecId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/ImmunizationRecommendation"] },
        patient: { reference: `urn:uuid:${patientId}` },
        date: immRecDateLocal ? localDatetimeToISOWithOffset(immRecDateLocal) : authoredOn,
        recommendation: [
          {
            vaccineCode: immRecText ? [{ text: immRecText }] : undefined,
            forecastStatus: immRecText ? { text: "Recommended" } : undefined,
          },
        ],
      };
      return rr;
    }

    // Build DocumentReference + Binary resources from files (or placeholder)
    async function buildDocAndBinaryResources() {
      const binaries = [];
      const docRefs = [];

      const toProcess = files.length > 0 ? files : [null]; // null => placeholder
      for (let i = 0; i < toProcess.length; i++) {
        const f = toProcess[i];
        const binId = docBinaryIds[i];
        const docId = docRefIds[i];

        let contentType = "application/pdf";
        let dataB64 = PLACEHOLDER_PDF_B64;
        let title = "placeholder.pdf";

        if (f) {
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

        // DocumentReference.type: use SNOMED immunization record coding so it aligns with Composition.section
        const docRef = {
          resourceType: "DocumentReference",
          id: docId,
          language: "en-IN",
          meta: { profile: ["http://hl7.org/fhir/StructureDefinition/DocumentReference"] },
          text: buildNarrative("DocumentReference", `<p>${title}</p>`),
          status: "current",
          type: { coding: [SNOMED_IMM_RECORD], text: "Immunization document" },
          subject: { reference: `urn:uuid:${patientId}` },
          date: authoredOn,
          content: [{ attachment: { contentType, title, url: `urn:uuid:${binId}` } }],
        };

        binaries.push(binary);
        docRefs.push(docRef);
      }

      return { binaries, docRefs };
    }

    // Build Composition referencing immunizations, immRec, docRefs
    function buildComposition(docRefsArr) {
      const entries = [];
      immIds.forEach(id => entries.push({ reference: `urn:uuid:${id}`, type: "Immunization" }));
      if (immRecId) entries.push({ reference: `urn:uuid:${immRecId}`, type: "ImmunizationRecommendation" });
      if (docRefsArr && docRefsArr.length) docRefsArr.forEach(dr => entries.push({ reference: `urn:uuid:${dr.id}`, type: "DocumentReference" }));

      const comp = {
        resourceType: "Composition",
        id: compId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Composition"] },
        text: buildNarrative("Composition", `<p>${title}</p><p>Author: ${PRACTITIONERS[selectedPractitionerIdx]?.name || ""}</p>`),
        status: status,
        type: { coding: [SNOMED_IMM_RECORD], text: "Immunization record" },
        subject: { reference: `urn:uuid:${patientId}` },
        ...(encounterId ? { encounter: { reference: `urn:uuid:${encounterId}` } } : {}),
        date: authoredOn,
        author: [{ reference: `urn:uuid:${practitionerId}`, display: PRACTITIONERS[selectedPractitionerIdx]?.name }],
        title: title,
        ...(custodianId ? { custodian: { reference: `urn:uuid:${custodianId}` } } : {}),
        section: [
          {
            title: "Immunization section",
            code: { coding: [SNOMED_IMM_RECORD], text: "Immunization record" },
            entry: entries.length ? entries : undefined,
            text: entries.length ? undefined : {
              status: "generated",
              div: `<div xmlns="http://www.w3.org/1999/xhtml" lang="en-IN" xml:lang="en-IN"><p>No immunization entries</p></div>`,
            },
          },
        ],
      };
      return comp;
    }

    // Build resources
    const patientRes = buildPatientResource();
    const practitionerRes = buildPractitionerResource();
    const encounterRes = buildEncounterResource();
    const custodianRes = buildCustodianOrg();
    const immunizationResources = buildImmunizationResources();
    const immRecResource = buildImmRecResource();
    const { binaries, docRefs } = await buildDocAndBinaryResources();
    const compositionRes = buildComposition(docRefs);

    // Compose Bundle (document)
    const bundleId = `ImmunizationBundle-${uuidv4()}`;
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

    if (encounterRes) bundle.entry.push({ fullUrl: `urn:uuid:${encounterRes.id}`, resource: encounterRes });
    if (custodianRes) bundle.entry.push({ fullUrl: `urn:uuid:${custodianRes.id}`, resource: custodianRes });

    immunizationResources.forEach((r, i) => bundle.entry.push({ fullUrl: `urn:uuid:${r.id}`, resource: r }));
    if (immRecResource) bundle.entry.push({ fullUrl: `urn:uuid:${immRecResource.id}`, resource: immRecResource });

    docRefs.forEach(dr => bundle.entry.push({ fullUrl: `urn:uuid:${dr.id}`, resource: dr }));
    binaries.forEach(b => bundle.entry.push({ fullUrl: `urn:uuid:${b.id}`, resource: b }));

    setJsonOut(JSON.stringify(bundle, null, 2));
    console.log("Generated Immunization Bundle:", bundle);
    alert("Bundle generated and logged in console. Copy JSON below to validate.");
  }

  /* ------------------------------- UI ------------------------------------- */
  return (
    <div className="container py-4">
      <h2 className="mb-3">Immunization Record — Builder</h2>

      {/* Patient card */}
      <div className="card mb-3">
        <div className="card-header">1. Patient <span className="text-danger">*</span></div>
        <div className="card-body">
          <div className="row g-3 mb-2">
            <div className="col-md-8">
              <label className="form-label">Select Patient</label>
              <select className="form-select" value={selectedPatientIdx} onChange={e => setSelectedPatientIdx(Number(e.target.value))}>
                {patients.map((p, i) => <option key={p.id || i} value={i}>{p.name} {p.abha_ref ? `(${p.abha_ref})` : ""}</option>)}
              </select>
            </div>
            <div className="col-md-4">
              <label className="form-label">ABHA Address</label>
              <select className="form-select" value={selectedAbha} onChange={e => setSelectedAbha(e.target.value)} disabled={!abhaOptions.length}>
                {abhaOptions.length === 0 ? <option value="">No ABHA</option> : abhaOptions.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
          </div>

          {selectedPatient && (
            <>
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
            </>
          )}
        </div>
      </div>

      {/* Practitioner */}
      <div className="card mb-3">
        <div className="card-header">2. Practitioner (Author) <span className="text-danger">*</span></div>
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-6">
              <label className="form-label">Select Practitioner</label>
              <select className="form-select" value={selectedPractitionerIdx} onChange={e => setSelectedPractitionerIdx(Number(e.target.value))}>
                {PRACTITIONERS.map((p, i) => <option key={p.id} value={i}>{p.name} ({p.qualification})</option>)}
              </select>
            </div>
            <div className="col-md-6">
              <label className="form-label">Practitioner (read only)</label>
              <input className="form-control" readOnly value={PRACTITIONERS[selectedPractitionerIdx]?.name || ""} />
            </div>
          </div>
        </div>
      </div>

      {/* Composition metadata */}
      <div className="card mb-3">
        <div className="card-header">3. Composition Metadata</div>
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-3">
              <label className="form-label">Status</label>
              <select className="form-select" value={status} onChange={e => setStatus(e.target.value)}>
                <option value="preliminary">preliminary</option>
                <option value="final">final</option>
                <option value="amended">amended</option>
                <option value="entered-in-error">entered-in-error</option>
              </select>
            </div>
            <div className="col-md-6">
              <label className="form-label">Title</label>
              <input className="form-control" value={title} onChange={e => setTitle(e.target.value)} />
            </div>
            <div className="col-md-3">
              <label className="form-label">Date/Time</label>
              <input type="datetime-local" className="form-control" value={dateTimeLocal} onChange={e => setDateTimeLocal(e.target.value)} />
            </div>

            <div className="col-md-6">
              <label className="form-label">Encounter (optional)</label>
              <input className="form-control" value={encounterText} onChange={e => setEncounterText(e.target.value)} placeholder="Encounter reference text (optional)" />
            </div>
            <div className="col-md-6">
              <label className="form-label">Custodian Organization (optional)</label>
              <input className="form-control" value={custodianName} onChange={e => setCustodianName(e.target.value)} placeholder="Organization name (optional)" />
            </div>
          </div>
        </div>
      </div>

      {/* Immunizations */}
      <div className="card mb-3">
        <div className="card-header">4. Immunizations (one or more) <span className="text-danger">*</span></div>
        <div className="card-body">
          {immunizations.map((m, i) => (
            <div key={i} className="border rounded p-2 mb-2">
              <div className="row g-2 align-items-end">
                <div className="col-md-5">
                  <label className="form-label">Vaccine (e.g. 'COVID-19 Vaccine') </label>
                  <input className="form-control" value={m.vaccineText} onChange={e => updateImmunization(i, "vaccineText", e.target.value)} placeholder="Vaccine name" />
                </div>
                <div className="col-md-3">
                  <label className="form-label">Date (optional)</label>
                  <input className="form-control" type="date" value={m.occurrenceDate} onChange={e => updateImmunization(i, "occurrenceDate", e.target.value)} />
                </div>
                <div className="col-md-2">
                  <label className="form-label">Status</label>
                  <select className="form-select" value={m.status} onChange={e => updateImmunization(i, "status", e.target.value)}>
                    <option value="completed">completed</option>
                    <option value="entered-in-error">entered-in-error</option>
                    <option value="unknown">unknown</option>
                  </select>
                </div>
                <div className="col-md-2 d-flex gap-1">
                  <div style={{ flex: 1 }}>
                    <label className="form-label">Lot</label>
                    <input className="form-control" value={m.lotNumber} onChange={e => updateImmunization(i, "lotNumber", e.target.value)} placeholder="Lot #" />
                  </div>
                  <div className="d-flex align-items-end">
                    <button className="btn btn-danger mb-1" onClick={() => removeImmunization(i)} disabled={immunizations.length === 1}>X</button>
                  </div>
                </div>
              </div>
            </div>
          ))}
          <button className="btn btn-sm btn-outline-secondary" onClick={addImmunization}>+ Add Immunization</button>
          <div className="form-text mt-2">Add at least one immunization or a recommendation / document to satisfy the section entry requirement.</div>
        </div>
      </div>

      {/* ImmunizationRecommendation (optional) */}
      <div className="card mb-3">
        <div className="card-header">5. ImmunizationRecommendation (optional)</div>
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-8">
              <label className="form-label">Recommendation summary/text</label>
              <input className="form-control" value={immRecText} onChange={e => setImmRecText(e.target.value)} placeholder="Recommendation summary (optional)" />
            </div>
            <div className="col-md-4">
              <label className="form-label">Recommendation date</label>
              <input type="date" className="form-control" value={immRecDateLocal} onChange={e => setImmRecDateLocal(e.target.value)} />
            </div>
          </div>
        </div>
      </div>

      {/* Documents (optional) */}
      <div className="card mb-3">
        <div className="card-header">6. Documents (optional) — DocumentReference + Binary</div>
        <div className="card-body">
          <div className="mb-2">
            <label className="form-label">Upload PDF / JPG / JPEG (multiple)</label>
            <input ref={fileInputRef} type="file" accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg" multiple onChange={onFilesPicked} />
          </div>
          {filePreviewNames.length === 0 ? <div className="text-muted">No files selected — placeholder PDF will be embedded if no files uploaded.</div> : (
            <ul className="list-group">
              {filePreviewNames.map((n, i) => (
                <li key={i} className="list-group-item d-flex justify-content-between align-items-center">
                  {n}
                  <button className="btn btn-sm btn-danger" onClick={() => removeFileAtIndex(i)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="mb-4">
        <button className="btn btn-primary" onClick={onBuildBundle}>Generate Immunization Bundle</button>
      </div>

      {/* Output */}
      <div className="card mb-5">
        <div className="card-header">Output JSON (Bundle)</div>
        <div className="card-body">
          <textarea className="form-control" rows={18} value={jsonOut} onChange={e => setJsonOut(e.target.value)} />
          <div className="mt-2 text-muted">Copy JSON and validate with your FHIR validator (Inferno / other).</div>
        </div>
      </div>
    </div>
  );
}
