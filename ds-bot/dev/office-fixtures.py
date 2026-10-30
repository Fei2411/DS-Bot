#!/usr/bin/env python3
# Generates the small Office fixtures under test/fixtures/office/. Run with the
# payload Python (app/build/runtime/primary-runtime/dependencies/python/python.exe):
#   <payload python> dev/office-fixtures.py
# Not shipped in the npm package.
import io
import os
import sys
import zipfile

from docx import Document
from docx.shared import Inches, Pt
from pptx import Presentation
from pptx.util import Inches as PInches, Pt as PPt
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from openpyxl import Workbook
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.utils import quote_sheetname
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), "..", "test", "fixtures", "office")


def png_bytes(color):
    img = Image.new("RGB", (64, 48), color)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def make_docx():
    doc = Document()
    doc.add_heading("Quarterly report", 0)
    doc.add_paragraph("Revenue grew in the north region.")
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).merge(table.cell(0, 1))
    table.cell(0, 0).text = "Region totals"
    table.cell(1, 0).text = "North"
    table.cell(1, 1).text = "42"
    doc.add_paragraph("Second paragraph with a field:")
    p = doc.add_paragraph()
    fld = p.add_run()
    instr = fld._element
    instr.addprevious  # noqa - placeholder, real field added below via XML
    doc.sections[0].header.paragraphs[0].text = "Report header"
    doc.sections[0].footer.paragraphs[0].text = "Confidential footer"
    doc.add_paragraph("Final closing paragraph.")
    path = os.path.join(OUT, "sample.docx")
    doc.save(path)
    touch_docx(path)


# python-docx cannot write comments, fields or tracked changes; patch the XML
# inside the ZIP the same way Word would write them.
def touch_docx(path):
    tmp = path + ".tmp"
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.namelist():
            data = zin.read(item)
            if item == "word/document.xml":
                text = data.decode("utf8")
                # A complex PAGE field as the last paragraph — inside the body
                # before its closing sectPr, never after it.
                sect = text.rfind("<w:sectPr")
                text = (text[:sect]
                        + '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
                        '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
                        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
                        '<w:r><w:t>1</w:t></w:r>'
                        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
                        + text[sect:])
                # Tracked changes in the first real paragraph: inserted word,
                # deleted word, moved text, a run-property change, and a
                # paragraph whose mark is deleted (merges on accept). Run-level
                # elements sit between runs, never inside w:t.
                text = text.replace(
                    "<w:r><w:t>Revenue grew in the north region.</w:t></w:r>",
                    '<w:r><w:t xml:space="preserve">Revenue grew </w:t></w:r>'
                    '<w:ins w:id="10" w:author="Ana"><w:r><w:t xml:space="preserve"> fast</w:t></w:r></w:ins>'
                    '<w:r><w:t xml:space="preserve"> in the north</w:t></w:r>'
                    '<w:del w:id="11" w:author="Ana"><w:r><w:delText xml:space="preserve"> old</w:delText></w:r></w:del>'
                    '<w:moveFromRangeStart w:name="m1" w:id="12"/>'
                    '<w:r><w:t xml:space="preserve"> region</w:t></w:r>'
                    '<w:moveFromRangeEnd/>'
                    '<w:r><w:rPr><w:rPrChange w:id="13" w:author="Ana"><w:rPr><w:b/></w:rPr></w:rPrChange></w:rPr><w:t>.</w:t></w:r>'
                    '<w:moveToRangeStart w:name="m1" w:id="14"/>'
                    '<w:moveTo w:id="16" w:author="Ana"><w:r><w:t xml:space="preserve"> moved</w:t></w:r></w:moveTo>'
                    '<w:moveToRangeEnd/>', 1)
                # A comment anchored to the second paragraph.
                text = text.replace(
                    "<w:r><w:t>Second paragraph with a field:</w:t></w:r>",
                    '<w:commentRangeStart w:id="0"/><w:r><w:t>Second paragraph with a field:</w:t></w:r>'
                    '<w:commentRangeEnd w:id="0"/>'
                    '<w:r><w:commentReference w:id="0"/></w:r>', 1)
                # Deleted paragraph mark on the third paragraph.
                idx = text.find("Final closing paragraph.")
                if idx > 0:
                    open_p = text.rfind("<w:p", 0, idx)
                    close_p = text.find(">", open_p) + 1
                    text = (text[:close_p]
                            + '<w:pPr><w:rPr><w:del w:id="15" w:author="Ana"/></w:rPr></w:pPr>'
                            + text[close_p:])
                data = text.encode("utf8")
            zout.writestr(item, data)
        # comments.xml + its relationship + content type.
        zout.writestr("word/comments.xml",
                      '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                      '<w:comment w:id="0" w:author="Ana" w:initials="A" w:date="2026-10-01T00:00:00Z">'
                      '<w:p><w:r><w:t>Check this field.</w:t></w:r></w:p></w:comment></w:comments>')
        rels_name = "word/_rels/document.xml.rels"
        # Rebuild rels + content types entries for comments.xml.
    # Second pass: add rel + override.
    with zipfile.ZipFile(tmp) as zin, zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.namelist():
            data = zin.read(item)
            if item == "word/_rels/document.xml.rels":
                text = data.decode("utf8")
                rid = max(int(t) for t in __import__("re").findall(r'rId(\d+)', text)) + 1
                text = text.replace("</Relationships>",
                                    f'<Relationship Id="rId{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>'
                                    "</Relationships>", 1)
                data = text.encode("utf8")
            elif item == "[Content_Types].xml":
                text = data.decode("utf8")
                text = text.replace("</Types>",
                                    '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
                                    "</Types>", 1)
                data = text.encode("utf8")
            zout.writestr(item, data)
    os.remove(tmp)


def make_pptx():
    prs = Presentation()
    prs.slide_width = PInches(10)
    prs.slide_height = PInches(7.5)
    blank = prs.slide_layouts[6]
    # Slide 1: title + content + picture + table + chart + group.
    s1 = prs.slides.add_slide(prs.slide_layouts[0])
    s1.shapes.title.text = "Overview"
    s1.placeholders[1].text = "Key numbers"
    s1.shapes.add_picture(io.BytesIO(png_bytes((80, 120, 200))), PInches(6.5), PInches(1), PInches(3), PInches(2))
    frame = s1.shapes.add_table(2, 2, PInches(0.5), PInches(4.5), PInches(4), PInches(1.2))
    frame.table.cell(0, 0).text = "Region"
    chart_data = CategoryChartData()
    chart_data.categories = ["Q1", "Q2"]
    chart_data.add_series("S", (3, 4))
    s1.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, PInches(5), PInches(4), PInches(4), PInches(3), chart_data)
    grp = s1.shapes.add_group_shape()
    box = grp.shapes.add_textbox(PInches(0.5), PInches(0.5), PInches(1.5), PInches(0.4))
    box.text_frame.text = "grouped"
    s1.notes_slide.notes_text_frame.text = "Speaker notes for the overview."
    # Slide 2: hidden.
    s2 = prs.slides.add_slide(prs.slide_layouts[1])
    s2.shapes.title.text = "Hidden appendix"
    s2._element.set("show", "0")
    # Slide 3: overlapping text boxes for the layout check.
    s3 = prs.slides.add_slide(blank)
    a = s3.shapes.add_textbox(PInches(1), PInches(1), PInches(3), PInches(2))
    a.text_frame.text = "First box"
    b = s3.shapes.add_textbox(PInches(2), PInches(1.5), PInches(3), PInches(2))
    b.text_frame.text = "Second box overlapping"
    prs.save(os.path.join(OUT, "sample.pptx"))


def make_xlsx():
    wb = Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    ws["A1"] = "Region"
    ws["B1"] = "Sales"
    ws["A2"] = "North"
    ws["B2"] = 42
    ws["A3"] = "South"
    ws["B3"] = 17
    ws["C2"] = "=B2*2"
    ws["C3"] = "=B3/0"  # error cell
    ws["C4"] = "=SUM(B2:B3)"
    ws["D1"] = "Report date"
    ws["D2"] = __import__("datetime").datetime(2026, 10, 1)
    ws["D2"].number_format = "yyyy-mm-dd"
    ws.merge_cells("A5:B5")
    wb.defined_names["Totals"] = DefinedName("Totals", attr_text=f"{quote_sheetname('Sheet1')}!$B$2:$B$3")
    wb.save(os.path.join(OUT, "sample.xlsx"))


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    make_docx()
    make_pptx()
    make_xlsx()
    print("fixtures written to", os.path.abspath(OUT))
