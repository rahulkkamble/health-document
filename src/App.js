// src/App.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import "bootstrap/dist/css/bootstrap.min.css";

/*
  Health Document Record (Prescription Record) builder
  - Patient fetched from /patients.json (public)
  - Practitioner from global PRACTITIONERS (no API)
  - ABHA addresses normalized and selectable
  - File upload: PDF / JPG / JPEG (multiple)
  - If no file uploaded, a small PDF placeholder base64 is used
  - Produces FHIR Bundle (document) containing:
      Composition (type: LOINC 34133-9 "Summarization of Episode Note")
      Patient
      Practitioner
      (optional) Organization (custodian)
      DocumentReference(s) + Binary(s)
  - Bundle.identifier uses urn:ietf:rfc:3986 + urn:uuid:<uuid>
  - All XHTML narratives include lang & xml:lang to avoid validator warnings
  - UI is Bootstrap-based (cards + rows) consistent with your previous forms
*/

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

/* Fixed LOINC coding for Composition.type (replaces SNOMED 419891008 to avoid validator error) */
const COMPOSITION_DOC_TYPE = { system: "http://loinc.org", code: "34133-9", display: "Summary of episode note" };

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
function resolveGlobalPractitioner() {
  const gp =
    (typeof window !== "undefined" &&
      (window.GlobalPractioner || window.GlobalPractitionerFHIR)) ||
    null;

  const fallback = {
    id: `TEMP-${uuidv4()}`,
    name: "Dr. ABC",
    license: "LIC-0000",
  };

  if (!gp) return fallback;

  const id = gp.id || fallback.id;
  const name =
    (Array.isArray(gp.name) && gp.name[0]?.text) ||
    (typeof gp.name === "string" ? gp.name : fallback.name);
  const license =
    (Array.isArray(gp.identifier) && gp.identifier[0]?.value) ||
    gp.license ||
    fallback.license;

  return { id, name, license };
}


/* ------------------------------- APP ------------------------------------- */

export default function App() {
  /* Patients (from /patients.json) */
  const [patients, setPatients] = useState([]);
  const [practitioner, setPractitioner] = useState(resolveGlobalPractitioner());
  const [selectedPatientIdx, setSelectedPatientIdx] = useState(-1);
  const selectedPatient = useMemo(() => (selectedPatientIdx >= 0 ? patients[selectedPatientIdx] : null), [patients, selectedPatientIdx]);

  /* ABHA addresses */
  const [abhaOptions, setAbhaOptions] = useState([]);
  const [selectedAbha, setSelectedAbha] = useState("");

  /* Composition fields */
  const [status, setStatus] = useState("final"); // preliminary | final | amended | entered-in-error
  const [title, setTitle] = useState("Prescription Record"); // required
  const [dateTimeLocal, setDateTimeLocal] = useState(() => {
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
  // const [jsonOut, setJsonOut] = useState("");

  /* Load patients on mount */
  // useEffect(() => {
  //   (async () => {
  //     try {
  //       const res = await fetch("/patients.json");
  //       const data = await res.json();
  //       const arr = Array.isArray(data) ? data : [];
  //       setPatients(arr);
  //       if (arr.length > 0) {
  //         setSelectedPatientIdx(0);
  //         const norm = normalizeAbhaAddresses(arr[0]);
  //         setAbhaOptions(norm);
  //         setSelectedAbha(norm.length ? norm[0].value : "");
  //       }
  //     } catch (e) {
  //       console.error("Failed loading /patients.json", e);
  //     }
  //   })();
  // }, []);

  // /* When selected patient changes, update ABHA options */
  // useEffect(() => {
  //   if (!selectedPatient) {
  //     setAbhaOptions([]);
  //     setSelectedAbha("");
  //     return;
  //   }
  //   const norm = normalizeAbhaAddresses(selectedPatient);
  //   setAbhaOptions(norm);
  //   setSelectedAbha(norm.length ? norm[0].value : "");
  // }, [selectedPatientIdx]); // eslint-disable-line

  useEffect(() => {
    const resolved = resolveGlobalPractitioner();
    if (resolved.name !== practitioner.name || resolved.license !== practitioner.license || resolved.id !== practitioner.id) {
      setPractitioner(resolved);
    }
  }, []);


  useEffect(() => {
    if (!selectedPatient) {
      setAbhaOptions([]);
      setSelectedAbha("");
      return;
    }
    const norm = normalizeAbhaAddresses(selectedPatient);
    setAbhaOptions(norm);
    setSelectedAbha(norm.length ? norm[0].value : "");
  }, [selectedPatient]); // FIX: depend on selectedPatient, not selectedPatientIdx


  /* Load patients on mount: API first, fallback to local */
  useEffect(() => {
    (async () => {
      try {
        // 🔹 Try API first
        const apiRes = await fetch(window.GlobalPatientAPI || "/api/v5/patients", {
          headers: {
            "Content-Type": "application/json",
            ...(window.GlobalAuthToken ? { "Authorization": `Bearer ${window.GlobalAuthToken}` } : {})
          }
        });
        if (!apiRes.ok) throw new Error("API fetch failed");
        const apiData = await apiRes.json();
        if (!Array.isArray(apiData) || apiData.length === 0) throw new Error("API returned empty");

        setPatients(apiData);
        setSelectedPatientIdx(0);
        const first = apiData[0];
        const norm = normalizeAbhaAddresses(first);
        setAbhaOptions(norm);
        setSelectedAbha(norm.length ? norm[0].value : "");
      } catch (apiErr) {
        // alert("⚠️ Patient not found in API. Falling back to local patients.json.");
        console.warn("API fetch failed, falling back to local patients.json", apiErr);
        try {
          const localRes = await fetch("/patients.json");
          const localData = await localRes.json();
          const arr = Array.isArray(localData) ? localData : [];
          setPatients(arr);
          if (arr.length > 0) {
            setSelectedPatientIdx(0);
            const norm = normalizeAbhaAddresses(arr[0]);
            setAbhaOptions(norm);
            setSelectedAbha(norm.length ? norm[0].value : "");
          }
        } catch (localErr) {
          console.error("Failed to fetch local patients.json:", localErr);
        }
      }
    })();
  }, []);

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
      fileInputRef.current.value = "";
    }
  }

  /* --------------------------- Build FHIR Bundle --------------------------- */
  async function onBuildBundle() {
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

    const authoredOn = localDatetimeToISOWithOffset(dateTimeLocal);

    // Generate ids for resources
    const compId = uuidv4();
    const patientId = uuidv4();
    // const practitionerId = uuidv4();
    const encounterId = encounterRefText ? uuidv4() : null;
    const custodianOrgId = custodianName ? uuidv4() : null;
    const attesterOrgId = attesterPartyType === "Organization" && attesterOrgName ? uuidv4() : null;

    // Prepare DocumentReference & Binary resources
    const docsToProcess = files.length > 0 ? files : [null]; // null indicates placeholder
    const binaryIds = docsToProcess.map(() => uuidv4());
    const docRefIds = docsToProcess.map(() => uuidv4());

    // Build Patient resource
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
        // text: buildNarrative("Patient", `<p>${p.name || ""}</p><p>${p.gender || ""} ${p.dob || ""}</p>`),
        identifier: identifiers,
        name: p.name ? [{ text: p.name }] : undefined,
        gender: p.gender ? String(p.gender).toLowerCase() : undefined,
        birthDate: ddmmyyyyToISO(p.dob) || undefined,
        telecom: telecom.length ? telecom : undefined,
        address: p?.address ? [{ text: p.address }] : undefined,
      };
    }

    const practitionerRes = {
      resourceType: "Practitioner",
      id: practitioner.id || uuidv4(),
      language: "en-IN",
      meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Practitioner"] },
      identifier: [
        {
          type: {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/v2-0203",
                code: "MD",
                display: "Medical License number"
              }
            ]
          },
          system: "https://doctor.ndhm.gov.in",
          value: practitioner.license || "LIC-0000"
        }
      ],
      name: [{ text: practitioner.name || "Dr. ABC" }]
    };

    // Optional Organization resources
    function buildOrganizationResource(orgId, orgName) {
      if (!orgName) return null;
      return {
        resourceType: "Organization",
        id: orgId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Organization"] },
        identifier: [
          {
            system: "https://facility.ndhm.gov.in",
            value: "HIP123456"   // 🔴 Replace with your real HIP facility code
          }
        ],
        name: orgName,
      };
    }

    // Build Encounter resource if text provided
    function buildEncounterResource() {
      if (!encounterId) return null;
      const start = isoWithLocalOffsetFromDate(new Date());
      return {
        resourceType: "Encounter",
        id: encounterId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Encounter"] },
        // text: buildNarrative("Encounter", `<p>${encounterRefText}</p>`),
        status: "finished",
        class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
        subject: { reference: `urn:uuid:${patientId}` },
        period: { start, end: start },
      };
    }

    // Build Binary + DocumentReference resources
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
          // text: buildNarrative("DocumentReference", `<p>${title}</p>`),
          status: "current",
          type: { coding: [{ system: "http://loinc.org", code: "34108-1", display: "Outpatient Note" }], text: "Outpatient Note" },
          subject: { reference: `urn:uuid:${patientId}` },
          date: authoredOn,
          content: [{ attachment: { contentType, title, url: `urn:uuid:${binId}` } }],
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

      if (attesterPartyType === "Practitioner") {
        attesterArr.push({ mode: attesterMode, party: { reference: `urn:uuid:${practitionerRes.id}` } });
      } else if (attesterPartyType === "Organization" && attesterOrgId) {
        attesterArr.push({ mode: attesterMode, party: { reference: `urn:uuid:${attesterOrgId}` } });
      }

      const composition = {
        resourceType: "Composition",
        id: compId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Composition"] },
        // text: buildNarrative("Composition", `<p>${title}</p><p>Author: ${practitionerName}</p>`),

        status: status,
        type: { coding: [COMPOSITION_DOC_TYPE], text: COMPOSITION_DOC_TYPE.display },
        subject: { reference: `urn:uuid:${patientId}` },
        ...(encounterReference ? { encounter: { reference: encounterReference } } : {}),
        date: authoredOn,
        // author: [{ reference: `urn:uuid:${practitionerRes.id}`, display: practitionerRes.name?.[0]?.text }],
        author: [{ reference: `urn:uuid:${practitionerRes.id}`, display: practitioner.name }],
        attester: [{ mode: "official", party: { reference: `urn:uuid:${practitionerRes.id}` } }],

        title: title,
        attester: (attesterArr.length ? attesterArr : [{ mode: "official", party: { reference: `urn:uuid:${practitionerRes.id}` } }]),
        ...(custodianOrgId ? { custodian: { reference: `urn:uuid:${custodianOrgId}` } } : {}),
        section: [
          {
            title: "Health documents",
            code: { coding: [COMPOSITION_DOC_TYPE], text: COMPOSITION_DOC_TYPE.display },
            entry: sectionEntries,
          },
        ],
      };

      return composition;
    }

    // Build the resources
    const patientRes = buildPatientResource();
    // const practitionerReferenceId = window.GlobalPractioner?.id || practitionerId;

    // const practitionerRes = {
    //   resourceType: "Practitioner",
    //   id: gp?.id || practitionerId,
    //   meta: gp?.meta || { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Practitioner"] },
    //   text: gp?.text || buildNarrative("Practitioner", `<p>${practitionerName}</p>`),
    //   identifier: gp?.identifier || [
    //     {
    //       type: {
    //         coding: [
    //           { system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MD", display: "Medical License number" }
    //         ]
    //       },
    //       system: "https://doctor.ndhm.gov.in",
    //       value: practitionerLicense
    //     }
    //   ],
    //   name: gp?.name || [{ text: practitionerName }]
    // };

    const encounterReference = encounterRefText ? `urn:uuid:${encounterId}` : undefined;
    const encounterRes = encounterId
      ? {
        resourceType: "Encounter",
        id: encounterId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Encounter"] },
        // text: buildNarrative("Encounter", `<p>${encounterRefText}</p>`),
        status: "finished",
        class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
        subject: { reference: `urn:uuid:${patientId}` },
        period: { start: isoWithLocalOffsetFromDate(new Date()), end: isoWithLocalOffsetFromDate(new Date()) },
      }
      : null;
    const custodianRes = custodianOrgId ? buildOrganizationResource(custodianOrgId, custodianName) : null;
    const attesterOrgRes = attesterOrgId ? buildOrganizationResource(attesterOrgId, attesterOrgName) : null;

    const { binaries, docRefs } = await buildDocAndBinaryResources();
    const compositionRes = buildCompositionResource(docRefs);

    // Build Bundle
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

    if (encounterRes) bundle.entry.push({ fullUrl: `urn:uuid:${encounterRes.id}`, resource: encounterRes });
    if (custodianRes) bundle.entry.push({ fullUrl: `urn:uuid:${custodianRes.id}`, resource: custodianRes });
    if (attesterOrgRes) bundle.entry.push({ fullUrl: `urn:uuid:${attesterOrgRes.id}`, resource: attesterOrgRes });

    docRefs.forEach(dr => {
      bundle.entry.push({ fullUrl: `urn:uuid:${dr.id}`, resource: dr });
    });
    binaries.forEach(b => {
      bundle.entry.push({ fullUrl: `urn:uuid:${b.id}`, resource: b });
    });

    console.log(selectedPatient.id);
    const patientId2 = Number(selectedPatient.user_id);
    axios.post('https://uat.discharge.org.in/api/v5/fhir-bundle', { bundle, patient: patientId2 })
      .then(response => {
        console.log('FHIR Bundle Submitted:', response.data);
        console.log({ bundle, patient: patientId2 })
        alert("FHIR Bundle Submitted Successfully");
      })
      .catch(error => {
        console.error('Error submitting FHIR Bundle:', error.response?.data || error.message);
        alert("Error submitting FHIR Bundle. See console.");
        console.log({ bundle, patient: patientId2 })
      });

    // setJsonOut(JSON.stringify(bundle, null, 2));
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
          <div className="row g-2">
            <div className="col-md-6">
              <label className="form-label">Name</label>
              <input className="form-control" readOnly value={practitioner?.name || ""} />

            </div>
            <div className="col-md-6">
              <label className="form-label">License</label>
              <input className="form-control" readOnly value={practitioner?.license || ""} />

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
                <label className="form-label">Attester Practitioner (read-only)</label>
                <input
                  className="form-control"
                  readOnly
                  value={practitioner?.name?.[0]?.text || "Practitioner"}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 5. Documents */}
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
        <button className="btn btn-primary" onClick={onBuildBundle}>Submit</button>
      </div>

    </div>
  );
}