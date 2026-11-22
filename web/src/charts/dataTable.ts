// SPDX-License-Identifier: Apache-2.0
import type { DataGrid, Dashboard } from 'sferic'

/**
 * Every grid table in zprof: a click on a heading sorts by that column (numbers largest
 * first, text A to Z), a second click reverses, a third restores the view's own order.
 * Rows keep their content index, so a view's row clicks, row colors and per-cell updates
 * are unaffected by the sort. Make every DataGrid through this.
 */
export function dataTable(dash: Dashboard, o: Parameters<Dashboard['createDataGrid']>[0]): DataGrid {
  return dash.createDataGrid(o).setSortable(true)
}
