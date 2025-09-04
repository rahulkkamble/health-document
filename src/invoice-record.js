// src/App.js
import React, { useEffect, useState } from "react";
import "bootstrap/dist/css/bootstrap.min.css";

/* ---------- Utilities ---------- */
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  }).toLowerCase();
}

// convert dd-mm-yyyy or dd/mm/yyyy -> yyyy-mm-dd; if already yyyy-mm-dd, return it
function toFhirDate(input) {
  if (!input) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const m = input.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
  if (m) {
    let dd = m[1].padStart(2, "0");
    let mm = m[2].padStart(2, "0");
    let yy = m[3].length === 2 ? "19" + m[3] : m[3];
    return `${yy}-${mm}-${dd}`;
  }
  const d = new Date(input);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return undefined;
}

/* ---------- Global practitioner (single object) ---------- */
/* Use a UUID as id (validator expects valid lowercase UUID). */
const GlobalPractitioner = {
  id: uuidv4(),
  name: "Dr. ABC",
  license: "LIC-1234",
};

/* ---------- App ---------- */
export default function App() {
  const [patients, setPatients] = useState([]);
  const [loadingPatients, setLoadingPatients] = useState(true);

  // UI selections
  const [selectedPatientIdx, setSelectedPatientIdx] = useState(null);
  const [selectedAbha, setSelectedAbha] = useState("");
  const [practitioner, setPractitioner] = useState({
    id: GlobalPractitioner.id,
    name: GlobalPractitioner.name,
    license: GlobalPractitioner.license,
  });

  // Invoice fields
  const [invoiceNumber, setInvoiceNumber] = useState(() => `INV-${Date.now()}`);
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [invoiceType, setInvoiceType] = useState("healthcare");
  const [lineItems, setLineItems] = useState([{ id: uuidv4(), description: "Consultation", amount: 500 }]);
  const [totalNet, setTotalNet] = useState("");
  const [totalGross, setTotalGross] = useState("");

  // result
  const [generatedBundle, setGeneratedBundle] = useState(null);
  const [generatedBundleJson, setGeneratedBundleJson] = useState("");

  /* ---------- fetch patients.json from public folder ---------- */
  useEffect(() => {
    let mounted = true;
    fetch("/patients.json")
      .then((r) => {
        if (!r.ok) throw new Error("no patient.json");
        return r.json();
      })
      .then((data) => {
        if (!mounted) return;
        if (Array.isArray(data)) setPatients(data);
        else setPatients([data]);
      })
      .catch((err) => {
        console.warn("Failed to fetch /patient.json — please place your patient file in public/patient.json", err);
        setPatients([]); // empty — user can still enter manually
      })
      .finally(() => mounted && setLoadingPatients(false));
    return () => (mounted = false);
  }, []);

  /* ---------- helpers ---------- */
  function getAbhaAddressesForPatient(pt) {
    if (!pt) return [];
    const arr = pt.additional_attributes?.abha_addresses ?? [];
    const normalized = (arr || []).map((a) => {
      if (!a) return null;
      if (typeof a === "string") return a;
      if (typeof a === "object") return a.address ?? JSON.stringify(a);
      return String(a);
    }).filter(Boolean);
    // include abha_ref at front if present
    if (pt.abha_ref && !normalized.includes(pt.abha_ref)) normalized.unshift(pt.abha_ref);
    // uniq
    return Array.from(new Set(normalized));
  }

  function addLineItem() {
    setLineItems((s) => [...s, { id: uuidv4(), description: "", amount: 0 }]);
  }
  function updateLineItem(id, patch) {
    setLineItems((s) => s.map((li) => (li.id === id ? { ...li, ...patch } : li)));
  }
  function removeLineItem(id) {
    setLineItems((s) => (s.length > 1 ? s.filter((li) => li.id !== id) : s));
  }

  function computeTotals() {
    const computed = lineItems.reduce((acc, it) => acc + (Number(it.amount || 0)), 0);
    setTotalNet(Number(totalNet || computed).toFixed(2));
    setTotalGross(Number(totalGross || computed).toFixed(2));
  }

  useEffect(() => {
    // auto recompute totals when line items change if user hasn't manually entered totals
    const computed = lineItems.reduce((acc, it) => acc + (Number(it.amount || 0)), 0);
    setTotalNet((prev) => (prev === "" ? Number(computed).toFixed(2) : prev));
    setTotalGross((prev) => (prev === "" ? Number(computed).toFixed(2) : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineItems.length]);

  /* ---------- Build FHIR Bundle ---------- */
  function buildBundle() {
    if (selectedPatientIdx === null) {
      alert("Please select a patient first.");
      return null;
    }
    const selPatient = patients[selectedPatientIdx];
    if (!selPatient) {
      alert("Selected patient not found.");
      return null;
    }
    if (!selectedAbha) {
      alert("Please select an ABHA address for the patient.");
      return null;
    }

    // ids — use patient.user_ref_id when available (it's a UUID in your dataset)
    const patientId = selPatient.user_ref_id ? selPatient.user_ref_id.toLowerCase() : uuidv4();
    const compId = uuidv4();
    const practitionerId = (practitioner.id && practitioner.id.length > 0) ? practitioner.id : uuidv4();
    const orgId = uuidv4();
    const invoiceId = uuidv4();

    // Patient resource
    const patientResource = {
      resourceType: "Patient",
      id: patientId,
      meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Patient"] },
      identifier: [
        {
          system: "http://terminology.hl7.org/CodeSystem/v2-0203",
          value: selPatient.user_ref_id || `mrn-${selPatient.id}`,
          type: {
            coding: [
              { system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR", display: "Medical record number" }
            ],
            text: "MR"
          }
        },
        {
          system: "http://nrces.in/CodeSystem/identifier-type",
          value: selectedAbha,
          type: {
            coding: [
              { system: "http://nrces.in/CodeSystem/identifier-type", code: "ABHA", display: "ABHA address" }
            ],
            text: "ABHA"
          }
        }
      ],
      name: [{ text: selPatient.name }],
      gender: selPatient.gender ? selPatient.gender.toLowerCase() : undefined,
      birthDate: toFhirDate(selPatient.dob),
      telecom: [
        ...(selPatient.mobile ? [{ system: "phone", value: selPatient.mobile, use: "mobile" }] : []),
        ...(selPatient.email ? [{ system: "email", value: selPatient.email }] : [])
      ],
      address: selPatient.address ? [{ text: selPatient.address }] : undefined,
      text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>Patient: ${selPatient.name}</p></div>` }
    };

    // Practitioner resource (from GlobalPractitioner but editable in UI)
    const practitionerResource = {
      resourceType: "Practitioner",
      id: practitionerId,
      meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Practitioner"] },
      identifier: [
        {
          system: "http://nrces.in/CodeSystem/identifier-type",
          value: `pract-${practitionerId}`, // internal id
          type: { coding: [{ system: "http://nrces.in/CodeSystem/identifier-type", code: "PR", display: "Practitioner" }], text: "PR" }
        }
      ],
      name: [{ text: practitioner.name || "Unknown Practitioner" }],
      qualification: practitioner.license
        ? [
          {
            identifier: [{ system: "http://your.org/licenses", value: practitioner.license }],
            code: {
              coding: [
                { system: "http://terminology.hl7.org/CodeSystem/v2-0360", code: "MD", display: "Doctor of Medicine" }
              ],
              text: "Medical License"
            }
          }
        ]
        : undefined,
      text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>Practitioner: ${practitioner.name}</p></div>` }
    };

    // Organization (issuer) resource
    const organizationResource = {
      resourceType: "Organization",
      id: orgId,
      meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Organization"] },
      identifier: [
        {
          system: "http://nrces.in/CodeSystem/identifier-type",
          value: "ORG-001",
          type: { coding: [{ system: "http://nrces.in/CodeSystem/identifier-type", code: "ORG", display: "Organization" }], text: "ORG" }
        }
      ],
      name: "Issuer Organization",
      text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>Issuer Organization</p></div>` }
    };

    // Invoice resource - follow NDHM invoice expectations:
    const netVal = Number(totalNet || lineItems.reduce((s, it) => s + Number(it.amount || 0), 0));
    const grossVal = Number(totalGross || netVal);

    const invoiceResource = {
      resourceType: "Invoice",
      id: invoiceId,
      meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Invoice"] },
      identifier: [
        { system: "https://your.hospital.org/invoices", value: invoiceNumber || `INV-${invoiceId}` }
      ],
      status: "issued",
      type: {
        coding: [{ system: "http://nrces.in/CodeSystem/invoice-type", code: invoiceType, display: "Invoice Type" }],
        text: invoiceType
      },
      date: invoiceDate || new Date().toISOString(),
      subject: { reference: `urn:uuid:${patientId}`, display: selPatient.name },
      recipient: { reference: `urn:uuid:${patientId}` },
      issuer: { reference: `urn:uuid:${orgId}` }, // must be Organization
      totalNet: { value: Number(netVal.toFixed(2)), currency: "INR" },
      totalGross: { value: Number(grossVal.toFixed(2)), currency: "INR" },
      lineItem: lineItems.map((li, idx) => ({
        sequence: idx + 1,
        chargeItemCodeableConcept: {
          coding: [{ system: "http://nrces.in/CodeSystem/invoice-item", code: `item-${idx + 1}`, display: li.description || `Item ${idx + 1}` }],
          text: li.description || `Item ${idx + 1}`
        },
        priceComponent: [
          {
            type: "base",
            code: {
              coding: [{ system: "http://nrces.in/CodeSystem/price-component", code: "base-price", display: "Base price" }],
              text: "Base price"
            },
            amount: { value: Number((li.amount || 0).toFixed(2)), currency: "INR" }
          }
        ]
      })),
      text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>Invoice ${invoiceNumber} for ${selPatient.name}</p></div>` }
    };

    // Composition (InvoiceRecord)
    const compositionResource = {
      resourceType: "Composition",
      id: compId,
      meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/InvoiceRecord"] },
      status: "final",
      type: {
        coding: [{ system: "http://nrces.in/CodeSystem/document-type", code: "INVR", display: "Invoice Record" }],
        text: "Invoice Record"
      },
      title: `Invoice ${invoiceNumber}`,
      date: new Date().toISOString(),
      subject: { reference: `urn:uuid:${patientId}`, display: selPatient.name },
      author: [{ reference: `urn:uuid:${practitionerId}`, display: practitioner.name }],
      attester: [
        {
          mode: "official",
          party: { reference: `urn:uuid:${practitionerId}` },
          time: new Date().toISOString()
        }
      ],
      section: [
        {
          title: "Invoice Section",
          code: {
            coding: [
              { system: "http://nrces.in/CodeSystem/section-type", code: "invoice", display: "Invoice" }
            ],
            text: "Invoice"
          },
          text: {
            status: "generated",
            div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>Invoice details</p></div>`
          },
          entry: [
            { reference: `urn:uuid:${invoiceId}`, type: "Invoice" }
          ]
        }
      ],

      text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml"><h3>Invoice Record</h3><p>Invoice for ${selPatient.name}</p></div>` }
    };

    // Bundle (document) — fullUrls use urn:uuid: + id, consistent with references above
    const bundle = {
      resourceType: "Bundle",
      id: uuidv4(),
      type: "document",
      timestamp: new Date().toISOString(),
      identifier: { system: "https://yourorg.com/fhir/bundles", value: `invoice-bundle-${Date.now()}` },
      entry: [
        { fullUrl: `urn:uuid:${compId}`, resource: compositionResource },
        { fullUrl: `urn:uuid:${patientId}`, resource: patientResource },
        { fullUrl: `urn:uuid:${practitionerId}`, resource: practitionerResource },
        { fullUrl: `urn:uuid:${orgId}`, resource: organizationResource },
        { fullUrl: `urn:uuid:${invoiceId}`, resource: invoiceResource }
      ]
    };

    setGeneratedBundle(bundle);
    setGeneratedBundleJson(JSON.stringify(bundle, null, 2));
    return bundle;
  }

  function downloadBundle() {
    if (!generatedBundleJson) {
      alert("Generate the bundle first.");
      return;
    }
    const blob = new Blob([generatedBundleJson], { type: "application/fhir+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `invoice-bundle-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* ---------- UI ---------- */
  return (
    <div className="container my-4">
      <h3>Invoice Record — Builder</h3>
      <p className="text-muted">Select a patient, pick ABHA address, edit practitioner if needed, add line items and generate FHIR Invoice Bundle.</p>

      <div className="card mb-3">
        <div className="card-body">
          <h5>Patient</h5>
          <div className="row g-2">
            <div className="col-md-6">
              <label className="form-label required">Patient</label>
              <select className="form-select" value={selectedPatientIdx ?? ""} onChange={(e) => {
                const v = e.target.value === "" ? null : Number(e.target.value);
                setSelectedPatientIdx(v);
                setSelectedAbha("");
              }}>
                <option value="">-- select patient --</option>
                {patients.map((p, i) => (
                  <option key={i} value={i}>
                    {p.name} {p.abha_ref ? `(${p.abha_ref})` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-md-6">
              <label className="form-label">ABHA address</label>
              <select className="form-select" disabled={selectedPatientIdx === null} value={selectedAbha} onChange={(e) => setSelectedAbha(e.target.value)}>
                <option value="">-- select abha --</option>
                {selectedPatientIdx !== null && getAbhaAddressesForPatient(patients[selectedPatientIdx]).map((a, idx) => (
                  <option key={idx} value={a}>{a}</option>
                ))}
              </select>
            </div>
          </div>

          {selectedPatientIdx !== null && (
            <div className="mt-3">
              <strong>Selected:</strong> {patients[selectedPatientIdx].name} • {patients[selectedPatientIdx].gender} • DOB: {patients[selectedPatientIdx].dob}
            </div>
          )}
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-body">
          <h5>Practitioner</h5>
          <div className="row g-2">
            <div className="col-md-5">
              <label className="form-label required">Name</label>
              <input className="form-control" value={practitioner.name} onChange={(e) => setPractitioner(p => ({ ...p, name: e.target.value }))} />
            </div>
            <div className="col-md-4">
              <label className="form-label required">License</label>
              <input className="form-control" value={practitioner.license} onChange={(e) => setPractitioner(p => ({ ...p, license: e.target.value }))} />
            </div>
            <div className="col-md-3">
              <label className="form-label">Practitioner ID</label>
              <input className="form-control" value={practitioner.id} readOnly />
            </div>
          </div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-body">
          <h5>Invoice</h5>
          <div className="row g-2">
            <div className="col-md-4">
              <label className="form-label required">Invoice No</label>
              <input className="form-control" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
            </div>
            <div className="col-md-3">
              <label className="form-label required">Date</label>
              <input type="date" className="form-control" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            </div>
            <div className="col-md-5">
              <label className="form-label">Type</label>
              <select className="form-select" value={invoiceType} onChange={(e) => setInvoiceType(e.target.value)}>
                <option value="healthcare">Healthcare</option>
                <option value="pharmacy">Pharmacy</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <hr />

          <h6>Line items</h6>
          {lineItems.map((li) => (
            <div className="row g-2 align-items-center mb-2" key={li.id}>
              <div className="col-md-7">
                <input className="form-control" placeholder="Description" value={li.description} onChange={(e) => updateLineItem(li.id, { description: e.target.value })} />
              </div>
              <div className="col-md-3">
                <input type="number" className="form-control" placeholder="Amount" value={li.amount} onChange={(e) => updateLineItem(li.id, { amount: Number(e.target.value) })} />
              </div>
              <div className="col-md-2 d-flex gap-2">
                <button className="btn btn-danger" onClick={() => removeLineItem(li.id)} disabled={lineItems.length <= 1}>Remove</button>
                {li === lineItems[lineItems.length - 1] && <button className="btn btn-secondary" onClick={addLineItem}>Add</button>}
              </div>
            </div>
          ))}

          <div className="row mt-2">
            <div className="col-md-3">
              <label className="form-label">Total Net (INR)</label>
              <input className="form-control" value={totalNet} onChange={(e) => setTotalNet(e.target.value)} />
            </div>
            <div className="col-md-3">
              <label className="form-label">Total Gross (INR)</label>
              <input className="form-control" value={totalGross} onChange={(e) => setTotalGross(e.target.value)} />
            </div>
          </div>

          <div className="mt-3">
            <button className="btn btn-success me-2" onClick={() => { buildBundle(); }} disabled={selectedPatientIdx === null}>Generate Bundle</button>
            <button className="btn btn-outline-secondary" onClick={downloadBundle} disabled={!generatedBundleJson}>Download JSON</button>
          </div>
        </div>
      </div>

      <div className="card mb-5">
        <div className="card-body">
          <h5>Generated bundle</h5>
          {!generatedBundleJson ? <div className="text-muted">No bundle yet — generate to preview.</div> : <pre style={{ maxHeight: 400, overflow: "auto", background: "#f8f9fa", padding: 12 }}>{generatedBundleJson}</pre>}
        </div>
      </div>

      <footer className="text-muted small">
        Notes: This version fixes the previous profile-matching issues by using <code>urn:uuid:&lt;id&gt;</code> consistently for fullUrl and references, ensures attester.mode is a single string, qualification.identifier is an array, and includes required Invoice totals and identifiers. You'll still see **non-blocking warnings** for custom NRCES CodeSystems (this is expected unless your validator resolves NRCES terminology).
      </footer>
    </div>
  );
}
