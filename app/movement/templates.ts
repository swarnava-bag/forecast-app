// Downloadable templates for the three raw daily source files, matching the
// exact export formats the engine reads (BizeeBuy SO / STN reports + the
// shipsheet "consolidate" sheet). Generated in-browser with SheetJS.
import * as XLSX from "xlsx";

type Template = { file: string; sheet: string; title?: string; headers: string[]; example: (string | number)[] };

export const TEMPLATES: Record<"forecast" | "so" | "stn" | "shipsheet", Template> = {
  forecast: {
    file: "Forecast_template.xlsx", sheet: "Forecast",
    headers: ["New Master SKU", "FG Code", "Channel", "Platform", "Qty"],
    example: ["BB_AFG", "14244N", "MT", "", 250000],
  },
  so: {
    file: "SO_template.xlsx", sheet: "Sheet1",
    title: "BizeeBuy :: Sales Order Status Report",
    headers: ["#", "Order ID", "PO No", "Order Date", "Order Time", "PO Date", "PO Expiry Date", "Appointment Date", "Party Name", "Party Address", "Party City", "Party Pincode", "Warehouse", "Product SKU", "Product Name", "Order Qty", "UoM", "Rate", "Order Value", "GST", "Total Amount", "Dispatch Qty", "Last Dispatch Date", "SO Status", "Invoice No", "Invoice Date"],
    example: [1, "ORD/00000001", "PO12345", "2026-07-01", "10:00:00", "2026-07-01", "2026-07-31", "N/A", "Zepto Limited", "Address", "Bengaluru", 560001, "YB FG Warehouse", "YB/10PrB/14154G", "10g Protein Bar - Blueberry Blast 50g", 288, "Nos", 36.67, 10560.96, 5, 11089.01, 288, "2026-07-03 15:15:02", "Closed", "INV-1", "2026-07-01"],
  },
  stn: {
    file: "STN_template.xlsx", sheet: "Sheet1",
    title: "BizeeBuy :: Finished Goods Stock Transfer Report",
    headers: ["#", "Date", "Request No", "From Warehouse", "To Warehouse", "Transport Mode", "Vehicle No", "Driver Details", "Stock Type", "FG Code", "FG Name", "FG Category", "UoM", "Batch No", "Qty", "Unit Cost (₹)", "Amount Cost (₹)", "GRN Qty", "GRN Shortage", "GRN Rejection", "GRN Actual Qty", "Timestamp", "Status", "GRN Date", "GRN", "Transit Time"],
    example: [1, "01-07-2026", "STK/TRNSF/00001", "YB FG Warehouse", "Mithra Associates", "By Road", "-", "-", "Finished Goods", "YB/MUS/14481N", "Muesli - High Protein 700g", "Protein Muesli", "Nos", "BATCH-1", 8710, 113.78, 991023.8, 8710, 0, 0, 8710, "2026-07-01 09:36:34", "Closed", "2026-07-01 09:36:38", "GRN/00000001", "0D/0h:00m04s"],
  },
  shipsheet: {
    file: "Shipsheet_template.xlsx", sheet: "Sheet1",
    headers: ["Shipsheet Date", "PO Date", "PO Expiry", "PO Number", "Customer", "Shipping Address", "Pincode", "City", "State", "Qty", "No. of Cases", "Appointment Date", "Ship Date", "Logistics Partner", "Lr Number", "Channel", "Actual Weight", "CFT Weight", "PO Order Value"],
    example: ["2026-07-30", "2026-07-22", "2026-08-01", "PO-0001", "Scootsy Logistics Private Ltd", "Address", 562114, "Bangalore", "Karnataka", 510, 51, "-", "", "", "", "", 5100, 5100, 108267],
  },
};

export function downloadTemplate(kind: "forecast" | "so" | "stn" | "shipsheet") {
  const t = TEMPLATES[kind];
  const aoa: (string | number)[][] = [];
  if (t.title) aoa.push([t.title]);
  aoa.push(t.headers);
  aoa.push(t.example);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, t.sheet);
  XLSX.writeFile(wb, t.file);
}
