defmodule SynixirWeb.ClientControllerTest do
  use SynixirWeb.ConnCase, async: true

  for {route, file} <- [
        {"/", "index.html"},
        {"/sdk", "sdk.html"},
        {"/kanban", "kanban.html"},
        {"/whiteboard", "whiteboard.html"},
        {"/rich-text", "rich-text.html"},
        {"/multiplayer-form", "multiplayer-form.html"},
        {"/flowchart", "flowchart.html"},
        {"/table", "table.html"},
        {"/sdk.html", "sdk.html"},
        {"/kanban.html", "kanban.html"},
        {"/whiteboard.html", "whiteboard.html"},
        {"/rich-text.html", "rich-text.html"},
        {"/multiplayer-form.html", "multiplayer-form.html"},
        {"/flowchart.html", "flowchart.html"},
        {"/table.html", "table.html"}
      ] do
    test "serves #{route} through the packaged client controller", %{conn: conn} do
      conn = get(conn, unquote(route))
      path = Application.app_dir(:synixir, "priv/static/" <> unquote(file))

      assert get_resp_header(conn, "cache-control") == ["no-store"]

      if File.regular?(path) do
        assert html_response(conn, 200) == File.read!(path)
      else
        assert response(conn, 404) ==
                 "Client assets are not built. Use the Next.js development server."
      end
    end
  end
end
