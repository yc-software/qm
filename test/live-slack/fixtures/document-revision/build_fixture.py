import argparse
import os
from hashlib import sha256
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle


parser = argparse.ArgumentParser(description="Build the synthetic document-revision PDF fixture.")
parser.add_argument("output", type=Path)
output = parser.parse_args().output
output.parent.mkdir(parents=True, exist_ok=True)
os.environ["SOURCE_DATE_EPOCH"] = "946684800"
INK = colors.HexColor("#17334A")
TEAL = colors.HexColor("#168A93")
body = ParagraphStyle("body", fontName="Helvetica", fontSize=9, leading=11.7, textColor=INK, spaceAfter=5)
heading = ParagraphStyle("heading", parent=body, fontName="Helvetica-Bold", fontSize=11, leading=13, spaceBefore=7)
small = ParagraphStyle("small", parent=body, fontSize=8, leading=10)


def header(canvas, doc):
    canvas.setTitle("Beacon Fieldwork - inspection reporting")
    canvas.setAuthor("Synthetic QA fixture")
    canvas.setFillColor(TEAL)
    canvas.saveState()
    canvas.translate(49, 744)
    canvas.rotate(45)
    canvas.rect(-10, -10, 20, 20, fill=1, stroke=0)
    canvas.restoreState()
    canvas.setFillColor(colors.HexColor("#F2B544"))
    canvas.circle(65, 757, 4, fill=1, stroke=0)
    canvas.setFillColor(INK)
    canvas.setFont("Helvetica-Bold", 19)
    canvas.drawString(81, 744, "BEACON FIELDWORK")
    canvas.setFont("Helvetica", 9)
    canvas.drawString(81, 729, "Inspection reporting, with the evidence attached")
    canvas.setStrokeColor(colors.HexColor("#BFD7DF"))
    canvas.line(36, 715, 576, 715)


sections = [
    ("Clear reports from the evidence your team already collects", "Beacon Fieldwork helps facilities teams turn inspection notes, photographs, equipment records, and approved templates into a reviewable first draft. It organizes the source material, fills the relevant sections, and gives a reviewer a clear route back to the evidence behind each statement. Your team remains responsible for approving the finished report and deciding what action to take."),
    ("The daily reporting problem", "After a site visit, engineers often spend another afternoon finding photographs, copying measurements, reconciling handwritten notes, and rebuilding a familiar document. Maintenance managers need actionable findings; operations leaders need a concise overview; compliance reviewers need traceable evidence. A polished summary alone does not meet all three needs. The supporting detail must survive the handoff between these readers."),
    ("How the workflow fits", "Collect: bring together the inspection notes, photographs, asset register, and current reporting template. Draft: organize the observations by equipment and location, place the evidence beside the relevant findings, and flag missing inputs. Review: let the responsible engineer correct the draft, approve the language, and export a document in the format the team already uses. The original evidence remains available throughout the process."),
    ("Reports and records supported", "Equipment inspection; preventive maintenance; site condition; corrective action; service visit; safety walk-through; asset handover; commissioning check; warranty assessment; incident follow-up; compliance evidence; monthly operations summary. These examples describe document workflows, not a promise that the product certifies equipment, replaces a qualified inspector, or independently determines regulatory compliance."),
    ("What changes for the team", "Use the comparison below to choose a starting workflow. It describes responsibilities and review steps rather than claiming a guaranteed time saving. Existing approval requirements remain in place, and unresolved evidence gaps stay visible to the person signing off."),
]

story = []
for title, text in sections:
    story.extend([Paragraph(title, heading), Paragraph(text, body)])

rows = [
    ["Task", "Today", "With Beacon Fieldwork"],
    ["Gather evidence", "Search notes and folders", "Group inputs by asset and visit"],
    ["Prepare a draft", "Copy into the reporting template", "Review a populated first draft"],
    ["Resolve gaps", "Chase missing context by email", "See unresolved inputs beside findings"],
    ["Approve the report", "Engineer checks and signs off", "Engineer checks and signs off"],
]
table = Table([[Paragraph(cell, small) for cell in row] for row in rows], colWidths=[100, 204, 236])
table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E9F2F5")),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBELOW", (0, 0), (-1, 0), 0.5, TEAL),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
]))
story.extend([table, Spacer(1, 5)])
story.extend([
    Paragraph("A focused three-week pilot", heading),
    Paragraph("Choose one recurring report, one site, and a small group of reviewers. In week one, agree the source material and the required output. In week two, prepare drafts alongside the current process and record the corrections reviewers make. In week three, compare completeness, reviewer effort, and the quality of the handoff. Decide together whether the workflow is useful enough to expand; there is no automatic commitment to a wider rollout.", body),
    Paragraph("A practical next step", heading),
    Paragraph("Bring a sample report and a typical set of notes to a 45-minute walkthrough. We will discuss the workflow, identify the evidence needed, and agree what a useful pilot would demonstrate. Sensitive operational material can be replaced with representative samples for the initial conversation.", body),
    Paragraph("Alex Lane | alex@beacon.example | 45-minute walkthrough", ParagraphStyle("contact", parent=body, fontName="Helvetica-Bold", spaceBefore=4)),
])
SimpleDocTemplate(str(output), invariant=1, pagesize=(612, 792), leftMargin=36, rightMargin=36, topMargin=82, bottomMargin=30).build(story, onFirstPage=header, onLaterPages=header)
digest = sha256(output.read_bytes()).hexdigest()
assert digest == "3e29e0f3bd11b051a0f207c5eb5a87d717aa681f8fa0398bab73581aedf62376", "Fixture bytes changed; check the ReportLab version and source."
print(f"{digest}  {output}")
